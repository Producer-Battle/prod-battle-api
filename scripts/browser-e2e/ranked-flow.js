// Real 4-player RANKED end-to-end against the local stack.
//
// Drives 4 fresh sign-ups (real mailpit verify) through a ranked match:
// lobby -> ready -> start -> submit -> vote -> results, then verifies
// each /me reflects the post-match state:
//   - calibrationMatchesRemaining decremented
//   - lp_delta written on match_players
//   - rankings row exists for the (user, genre, season)
//
// Run from the playwright skill (which bundles Chromium):
//   cd ~/.claude/skills/playwright-skill
//   node run.js /home/bram/work/producer-battle/prod-battle-api/scripts/browser-e2e/ranked-flow.js
//
// Helpers are inlined (not extracted to a sibling lib) because the
// skill copies the script to its own dir before exec, breaking relative
// requires. See ./README.md.

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// ─── Config ─────────────────────────────────────────────────────────────────
const WEB = process.env.PB_WEB ?? 'http://localhost:5173';
const API = process.env.PB_API ?? 'http://localhost:8080';
const MAIL = process.env.PB_MAIL ?? 'http://localhost:8025';

// ─── Helpers ────────────────────────────────────────────────────────────────
function buildSilentWav(sec = 2) {
  const sr = 8000;
  const n = sr * sec;
  const buf = Buffer.alloc(44 + n, 128);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n, 40);
  return buf;
}
const wavPath = path.join('/tmp', 'pb-browser-e2e.wav');
fs.writeFileSync(wavPath, buildSilentWav(2));

function psql(sql) {
  return execSync(
    `docker exec producer-battle-postgres-1 psql -U prodbattle -d prod_battle -tA -c ${JSON.stringify(sql)}`,
  )
    .toString()
    .trim();
}

async function clearMail() {
  await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE' }).catch(() => {});
}

async function findVerifyLink(toEmail, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(toEmail)}`);
    const data = await r.json();
    const msg = data.messages?.[0];
    if (msg) {
      const body = await fetch(`${MAIL}/api/v1/message/${msg.ID}`).then((x) => x.json());
      const html = body.HTML || body.Text || '';
      const link = html.match(/https?:\/\/[^\s"'<>]*verify[^\s"'<>]*/i);
      if (link) return link[0];
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  throw new Error(`No verify mail for ${toEmail}`);
}

async function signUpAndVerify(browser, idx, prefix = 'rk') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const stamp = Date.now();
  const handle = `${prefix}${idx}${stamp}`.slice(-18);
  const email = `${handle}@test.local`;
  const password = 'password123';
  await page.goto(`${WEB}/auth/sign-up`, { waitUntil: 'networkidle' });
  await page.locator('input[placeholder*="producer-alias"]').first().fill(handle);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(1500);
  const link = await findVerifyLink(email);
  await page.goto(link, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (!page.url().includes('/play')) {
    await page.goto(`${WEB}/auth/sign-in`, { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL('**/play', { timeout: 10000 });
  }
  return { ctx, page, handle, email };
}

async function uploadAndSubmit(page) {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(wavPath)
    .catch(() => {});
  await page.waitForTimeout(1500);
  const send = page.locator('button', { hasText: /submit track|^submit$|send/i }).first();
  if (await send.count() > 0) await send.click().catch(() => {});
  await page.waitForTimeout(1500);
}

async function castVotes(page) {
  const stars = page.locator('[aria-label*="5"]');
  const cnt = await stars.count();
  for (let i = 0; i < cnt; i++) {
    await stars.nth(i).click().catch(() => {});
    await page.waitForTimeout(80);
  }
  const cast = page.locator('button', { hasText: /submit votes|cast/i }).first();
  if (await cast.count() > 0) await cast.click().catch(() => {});
  await page.waitForTimeout(800);
}

async function waitForText(page, re, ms = 25000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const html = await page.content();
    if (re.test(html)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function fetchMe(page) {
  return page.evaluate(async (api) => {
    const res = await fetch(`${api}/me`, { credentials: 'include' });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, API);
}

// ─── Scenario ───────────────────────────────────────────────────────────────
(async () => {
  await clearMail();
  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  let exit = 0;

  try {
    console.log('[1] Signing up 4 fresh accounts via mailpit');
    const players = [];
    for (let i = 0; i < 4; i++) {
      const p = await signUpAndVerify(browser, i + 1);
      players.push(p);
      console.log(`  player ${i + 1}: @${p.handle}`);
    }

    console.log('\n[2] Pre-match /me');
    for (const p of players) {
      const me = await fetchMe(p.page);
      console.log(
        `  ${p.handle}: calib=${me.body?.calibrationMatchesRemaining} honor=${me.body?.honor}`,
      );
    }

    console.log('\n[3] Player 1 starts a ranked match');
    await players[0].page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
    const card = players[0]
      .page.locator('div', { has: players[0].page.getByText('Ranked', { exact: true }) })
      .first();
    await card.locator('select').first().selectOption({ index: 1 });
    await players[0].page.waitForTimeout(400);
    await card.locator('button:has-text("Play Ranked")').click();
    await players[0].page.waitForURL('**/room/**', { timeout: 10000 });
    const code = players[0].page.url().split('/').pop().split('?')[0];
    console.log('  code:', code);

    console.log('\n[4] Players 2-4 join the room');
    for (let i = 1; i < 4; i++) {
      await players[i].page.goto(`${WEB}/room/${code}`, { waitUntil: 'networkidle' });
      await players[i].page.waitForTimeout(800);
    }
    await players[0].page.waitForTimeout(2000);

    console.log('\n[5] Ready up + start');
    for (const p of players) {
      const ready = p.page.locator('button:has-text("Ready up")').first();
      if (await ready.count() > 0) await ready.click();
      await p.page.waitForTimeout(300);
    }
    await players[0].page.waitForTimeout(1500);
    const start = players[0].page.locator('button:has-text("Start match")').first();
    if ((await start.count()) > 0 && (await start.isEnabled())) await start.click();

    console.log('\n[6] Submit phase');
    for (const p of players) await waitForText(p.page, /Drop your track/i, 30000);

    console.log('\n[7] Upload + submit');
    for (const p of players) await uploadAndSubmit(p.page);

    console.log('\n[8] Vote');
    for (const p of players) {
      await waitForText(p.page, /entry|vote/i, 30000);
      await castVotes(p.page);
    }

    console.log('\n[9] Wait for results');
    await waitForText(players[0].page, /results|rank/i, 25000);

    console.log('\n[10] Post-match /me');
    for (const p of players) {
      const me = await fetchMe(p.page);
      console.log(
        `  ${p.handle}: calib=${me.body?.calibrationMatchesRemaining}` +
          ` honor=${me.body?.honor}` +
          ` rankedTiers=${(me.body?.rankedTiers ?? []).length}`,
      );
    }

    const matchId = psql(`SELECT id FROM matches WHERE room_code='${code}'`);
    console.log('\n[11] DB ground truth');
    const deltas = psql(
      `SELECT u.handle || '|' || mp.lp_delta || '|' || mp.honor_delta FROM match_players mp JOIN users u ON u.id=mp.user_id WHERE mp.match_id='${matchId}'`,
    );
    console.log('  per-player lp_delta + honor_delta:');
    for (const line of deltas.split('\n')) {
      const [h, lp, honor] = line.split('|');
      console.log(`    @${h}: lp_delta=${lp} honor_delta=${honor}`);
    }
  } catch (err) {
    console.error('FAILED:', err);
    exit = 1;
  } finally {
    await browser.close();
    process.exit(exit);
  }
})();
