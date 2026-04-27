// Anti-grief E2E. Two scenarios run back-to-back against the local stack:
//
//   A) Empty submission - one of 4 players never uploads. After the match
//      ends, that player should be flagged abandoned=true with a negative
//      honor delta, and users.honor should drop accordingly.
//
//   B) Mid-match disconnect - one of 4 players closes their tab during
//      submit phase. The tick-worker grace scan should mark them abandoned
//      via the _mid penalty.
//
// We lower reconnect.graceSeconds to 5 via direct SQL for the duration of
// the test (production stays at 120) and explicitly DEL the presence
// Redis key for the disconnected player - the existing key's TTL was set
// at WS-connect time using the OLD graceSeconds, so the lowered value
// only kicks in for new connections after the cache refresh.
//
// Run from the playwright skill (which bundles Chromium):
//   cd ~/.claude/skills/playwright-skill
//   node run.js /home/bram/work/producer-battle/prod-battle-api/scripts/browser-e2e/antigrief.js
//
// Helpers are inlined (not extracted to a sibling lib) because the
// skill copies the script to its own dir before exec. See ./README.md.

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// ─── Config ─────────────────────────────────────────────────────────────────
const WEB = process.env.PB_WEB ?? 'http://localhost:5173';
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

function redis(...args) {
  return execSync(
    `docker exec producer-battle-redis-1 redis-cli ${args.map((a) => JSON.stringify(a)).join(' ')}`,
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

async function signUpAndVerify(browser, idx, prefix) {
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

// ─── DB probes ──────────────────────────────────────────────────────────────
function pickAbandonRow(handle, matchId) {
  const out = psql(
    `SELECT honor_delta, abandoned, completed_at IS NOT NULL FROM match_players mp JOIN users u ON u.id=mp.user_id WHERE u.handle='${handle}' AND mp.match_id='${matchId}'`,
  );
  const [delta, abandoned, hasCompleted] = out.split('|');
  return {
    honorDelta: Number(delta),
    abandoned: abandoned === 't',
    hasCompletedAt: hasCompleted === 't',
  };
}
function pickHonor(handle) {
  return Number(psql(`SELECT honor FROM users WHERE handle='${handle}'`));
}
function pickRoomMatchId(code) {
  return psql(`SELECT id FROM matches WHERE room_code='${code}'`);
}
function pickUserId(handle) {
  return psql(`SELECT id FROM users WHERE handle='${handle}'`);
}
function lowerGraceTo(seconds) {
  psql(
    `UPDATE game_rules SET payload = payload || jsonb_build_object('graceSeconds', ${seconds}) WHERE category='reconnect'`,
  );
}
function restoreGrace() {
  psql(
    `UPDATE game_rules SET payload = payload || jsonb_build_object('graceSeconds', 120) WHERE category='reconnect'`,
  );
}

// ─── Scenarios ──────────────────────────────────────────────────────────────
async function runScenarioA(browser) {
  console.log('\n=== Scenario A: empty submission ===');
  console.log('[A1] sign up 4 fresh users');
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await signUpAndVerify(browser, i + 1, 'gA'));

  console.log('[A2] player 1 creates quickplay; rest join');
  await players[0].page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
  await players[0].page.locator('button:has-text("Quick Play")').first().click();
  await players[0].page.waitForURL('**/room/**', { timeout: 10000 });
  const code = players[0].page.url().split('/').pop().split('?')[0];
  console.log('  code:', code);
  for (let i = 1; i < 4; i++) {
    await players[i].page.goto(`${WEB}/room/${code}`, { waitUntil: 'networkidle' });
    await players[i].page.waitForTimeout(500);
  }
  await players[0].page.waitForTimeout(2000);
  for (const p of players) {
    const r = p.page.locator('button:has-text("Ready up")').first();
    if (await r.count() > 0) await r.click();
    await p.page.waitForTimeout(200);
  }
  await players[0].page.waitForTimeout(1500);
  await players[0].page
    .locator('button:has-text("Start match")')
    .first()
    .click()
    .catch(() => {});

  console.log('[A3] reaching submit phase');
  for (const p of players) await waitForText(p.page, /Drop your track/i, 30000);

  console.log('[A4] players 1-3 submit; player 4 idles');
  for (let i = 0; i < 3; i++) await uploadAndSubmit(players[i].page);

  console.log('[A5] force-advance submit -> vote (sim tick at submit timeout)');
  const matchId = pickRoomMatchId(code);
  psql(
    `UPDATE matches SET status='vote' WHERE id='${matchId}'; UPDATE battle_phases SET current_phase='vote'::match_phase, transitions_at=now() WHERE match_id='${matchId}'`,
  );
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 3; i++) {
    await waitForText(players[i].page, /entry|vote/i, 30000);
    await castVotes(players[i].page);
  }
  await waitForText(players[0].page, /results|rank/i, 25000);

  console.log('[A6] verify abandoned + honor delta on idle player');
  const idle = players[3];
  const row = pickAbandonRow(idle.handle, matchId);
  const honor = pickHonor(idle.handle);
  console.log(
    `  ${idle.handle}: abandoned=${row.abandoned} delta=${row.honorDelta} honor=${honor}`,
  );
  const pass = row.abandoned && row.honorDelta < 0 && honor < 100;
  console.log(pass ? '  ✅ Scenario A passed' : '  ❌ Scenario A failed');

  for (const p of players) await p.ctx.close();
  return pass;
}

async function runScenarioB(browser) {
  console.log('\n=== Scenario B: mid-match disconnect ===');
  console.log('[B1] sign up 4 fresh users');
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await signUpAndVerify(browser, i + 1, 'gB'));

  console.log('[B2] start quickplay');
  await players[0].page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
  await players[0].page.locator('button:has-text("Quick Play")').first().click();
  await players[0].page.waitForURL('**/room/**', { timeout: 10000 });
  const code = players[0].page.url().split('/').pop().split('?')[0];
  console.log('  code:', code);
  for (let i = 1; i < 4; i++) {
    await players[i].page.goto(`${WEB}/room/${code}`, { waitUntil: 'networkidle' });
    await players[i].page.waitForTimeout(500);
  }
  await players[0].page.waitForTimeout(2000);
  for (const p of players) {
    const r = p.page.locator('button:has-text("Ready up")').first();
    if (await r.count() > 0) await r.click();
    await p.page.waitForTimeout(200);
  }
  await players[0].page.waitForTimeout(1500);
  await players[0].page
    .locator('button:has-text("Start match")')
    .first()
    .click()
    .catch(() => {});

  console.log('[B3] reach submit phase');
  for (const p of players) await waitForText(p.page, /Drop your track/i, 30000);

  console.log('[B4] player 4 closes tab + simulate grace expiry');
  const matchId = pickRoomMatchId(code);
  const dcUserId = pickUserId(players[3].handle);
  await players[3].ctx.close();
  redis('DEL', `presence:${matchId}:${dcUserId}`);
  console.log('  waiting 32s for tick worker grace scan...');
  await new Promise((r) => setTimeout(r, 32000));

  const row = pickAbandonRow(players[3].handle, matchId);
  const honor = pickHonor(players[3].handle);
  console.log(
    `  ${players[3].handle}: abandoned=${row.abandoned} delta=${row.honorDelta} honor=${honor}`,
  );
  const pass = row.abandoned && row.honorDelta < 0;
  console.log(pass ? '  ✅ Scenario B passed' : '  ❌ Scenario B failed');

  for (let i = 0; i < 3; i++) await players[i].ctx.close();
  return pass;
}

(async () => {
  await clearMail();
  lowerGraceTo(5);
  console.log('[setup] lowered reconnect.graceSeconds to 5');

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  let allPassed = true;

  try {
    allPassed = (await runScenarioA(browser)) && allPassed;
    allPassed = (await runScenarioB(browser)) && allPassed;
  } catch (err) {
    console.error('FAILED:', err);
    allPassed = false;
  } finally {
    restoreGrace();
    console.log('\n[teardown] restored reconnect.graceSeconds to 120');
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
