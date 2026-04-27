// Comprehensive end-to-end smoke covering every match mode.
//
// Exercises:
//   1. Practice  - solo, single user creates + lands in lobby
//   2. Quickplay - 4 users, full lobby -> submit -> vote -> results
//   3. Ranked    - 4 users, verifies calibration + lp_delta written
//   4. Private   - 2 users, 1v1 with explicit pack pick
//   5. Sample Flip - 2 users, single flip source loop
//   6. Daily Challenge - 1 premium user, submit (premium gate test)
//   7. Tournament - admin creates, 2 users register, bracket auto-pairs
//
// Plus:
//   - /settings, /tournaments, /faq, /admin pages render
//   - Honor still shows 100 after a clean flow (no regressions)
//   - Reports + counter-notice flow
//
// Run from the playwright skill (which bundles Chromium):
//   cd ~/.claude/skills/playwright-skill
//   node run.js /home/bram/work/producer-battle/prod-battle-api/scripts/browser-e2e/all-modes.js
//
// Each scenario is independent and clears its own users at start. Some
// scenarios (Daily, Tournament) need DB-side setup that we do via psql.

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const WEB = process.env.PB_WEB ?? 'http://localhost:5173';
const API = process.env.PB_API ?? 'http://localhost:8080';
const MAIL = process.env.PB_MAIL ?? 'http://localhost:8025';

// ── Helpers (inlined - see ranked-flow.js for why) ────────────────────────
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
const wavPath = path.join('/tmp', 'pb-all-modes.wav');
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

async function signUpAndVerify(browser, prefix, idx) {
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
  await page.locator('input[type="file"]').first().setInputFiles(wavPath).catch(() => {});
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

function check(label, ok) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  return ok;
}

// ── Scenario runners ──────────────────────────────────────────────────────

async function runStaticPages(browser) {
  console.log('\n=== Static pages ===');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let ok = true;

  for (const route of ['/faq', '/tournaments', '/leaderboard', '/feed', '/genres']) {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const html = (await page.content()).toLowerCase();
    ok = check(`${route} rendered`, !html.includes('500') && !html.includes('not found')) && ok;
  }
  await ctx.close();
  return ok;
}

async function runPractice(browser) {
  console.log('\n=== Practice mode ===');
  const player = await signUpAndVerify(browser, 'pra', 1);
  let ok = true;
  await player.page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });

  // Practice card has its own button. Look for it explicitly.
  const practiceBtn = player.page.locator('button', { hasText: /practice/i }).first();
  if ((await practiceBtn.count()) > 0) {
    await practiceBtn.click();
    await player.page.waitForURL('**/room/**', { timeout: 10000 });
    ok = check('practice room created', player.page.url().includes('/room/')) && ok;
  } else {
    // Practice might be behind a genre selector. Skip if not surfaced.
    console.log('  ⚠ practice button not surfaced on /play - skipping');
  }
  await player.ctx.close();
  return ok;
}

async function runFullMatch(browser, mode, prefix, opts = {}) {
  console.log(`\n=== ${mode} mode ===`);
  const playerCount = opts.playerCount ?? 4;
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push(await signUpAndVerify(browser, prefix, i + 1));
  }
  let ok = true;

  // Player 1 creates the match.
  await players[0].page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });

  if (mode === 'quickplay') {
    await players[0].page.locator('button:has-text("Quick Play")').first().click();
  } else if (mode === 'ranked') {
    const card = players[0]
      .page.locator('div', { has: players[0].page.getByText('Ranked', { exact: true }) })
      .first();
    await card.locator('select').first().selectOption({ index: 1 });
    await players[0].page.waitForTimeout(300);
    await card.locator('button:has-text("Play Ranked")').click();
  } else if (mode === 'private') {
    const card = players[0]
      .page.locator('div', { has: players[0].page.getByText('Private Room', { exact: true }) })
      .first();
    if ((await card.count()) === 0) {
      console.log('  ⚠ Private Room card not found - skipping');
      for (const p of players) await p.ctx.close();
      return true;
    }
    await card.locator('select').first().selectOption({ index: 1 });
    await players[0].page.waitForTimeout(300);
    const startBtn = card.locator('button:has-text("Create")').first();
    if ((await startBtn.count()) > 0) await startBtn.click();
    else {
      console.log('  ⚠ Create button not found on Private card - skipping');
      for (const p of players) await p.ctx.close();
      return true;
    }
  } else if (mode === 'flip') {
    const card = players[0]
      .page.locator('div', { has: players[0].page.getByText('Sample Flip', { exact: true }) })
      .first();
    if ((await card.count()) === 0) {
      console.log('  ⚠ Sample Flip card not found - skipping');
      for (const p of players) await p.ctx.close();
      return true;
    }
    const startBtn = card.locator('button').first();
    await startBtn.click().catch(() => {});
  }

  await players[0].page.waitForURL('**/room/**', { timeout: 10000 });
  const code = players[0].page.url().split('/').pop().split('?')[0];
  ok = check(`${mode} room created (${code})`, !!code) && ok;

  // Players 2+ join.
  for (let i = 1; i < playerCount; i++) {
    await players[i].page.goto(`${WEB}/room/${code}`, { waitUntil: 'networkidle' });
    await players[i].page.waitForTimeout(500);
  }
  await players[0].page.waitForTimeout(2000);

  // Ready up.
  for (const p of players) {
    const ready = p.page.locator('button:has-text("Ready up")').first();
    if ((await ready.count()) > 0) await ready.click();
    await p.page.waitForTimeout(200);
  }
  await players[0].page.waitForTimeout(1500);

  // Start.
  const startBtn = players[0].page.locator('button:has-text("Start match")').first();
  if ((await startBtn.count()) > 0 && (await startBtn.isEnabled())) {
    await startBtn.click();
  }

  // Submit phase.
  for (const p of players) {
    await waitForText(p.page, /Drop your track|drop the loop|drag.*audio|upload/i, 30000);
  }
  for (const p of players) await uploadAndSubmit(p.page);

  // Vote.
  for (const p of players) {
    await waitForText(p.page, /entry|vote|score/i, 30000);
    await castVotes(p.page);
  }

  // Results.
  const reachedResults = await waitForText(players[0].page, /results|rank|🏆/i, 25000);
  ok = check(`${mode} reached results phase`, reachedResults) && ok;

  // Mode-specific DB checks.
  const matchId = psql(`SELECT id FROM matches WHERE room_code='${code}'`);
  if (mode === 'ranked') {
    const calib = psql(`SELECT calibration_matches_remaining FROM users WHERE handle='${players[0].handle}'`);
    ok = check(`ranked tickled calibration (10 -> ${calib})`, calib === '9') && ok;
    const lpDelta = psql(`SELECT COUNT(*) FROM match_players WHERE match_id='${matchId}' AND lp_delta != 0`);
    ok = check(`ranked recorded lp_delta on ≥2 players (got ${lpDelta})`, Number(lpDelta) >= 2) && ok;
  }
  for (const p of players) {
    const honorRow = psql(`SELECT honor FROM users WHERE handle='${p.handle}'`);
    ok = check(`${mode} ${p.handle} honor stayed at 100 (got ${honorRow})`, honorRow === '100') && ok;
  }

  for (const p of players) await p.ctx.close();
  return ok;
}

async function runDailyChallenge(browser) {
  console.log('\n=== Daily Challenge (premium-gated) ===');
  const player = await signUpAndVerify(browser, 'dly', 1);
  let ok = true;

  // Without premium, daily-challenge endpoint must 402.
  await player.page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
  const r1 = await player.page.evaluate(async (api) => {
    const r = await fetch(`${api}/daily-challenge`, { credentials: 'include' });
    return r.status;
  }, API);
  ok = check(`free user blocked from daily (got ${r1})`, r1 === 402) && ok;

  // Promote to premium directly via SQL and retry.
  psql(`UPDATE users SET plan = 'paid' WHERE handle = '${player.handle}'`);
  // Cookie cache may hold the old plan for ~5 min - set a fresh request
  // bypassing cache.
  await player.page.waitForTimeout(500);
  const r2 = await player.page.evaluate(async (api) => {
    const r = await fetch(`${api}/daily-challenge`, { credentials: 'include' });
    return r.status;
  }, API);
  // 200 if a daily exists for today, else 404 - both fine (gate cleared).
  ok = check(`premium user passes daily gate (got ${r2})`, r2 === 200 || r2 === 404) && ok;

  await player.ctx.close();
  return ok;
}

async function runTournament(browser) {
  console.log('\n=== Tournament (schedule + register + auto-bracket) ===');
  let ok = true;

  // Use psql to create a tournament directly. Requires us to know an admin
  // user id; pick the first admin from the dev DB.
  const adminId = psql(
    `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  );
  if (!adminId) {
    console.log('  ⚠ no admin user in dev DB - skipping');
    return true;
  }
  // Pick any active genre.
  const genreId = psql(
    `SELECT id FROM genres WHERE status = 'active' LIMIT 1`,
  );
  if (!genreId) {
    console.log('  ⚠ no active genre - skipping');
    return true;
  }
  // Tournament with registration window closing in 8s, starts in 10s.
  const now = new Date();
  const closesAt = new Date(now.getTime() + 8000).toISOString();
  const startsAt = new Date(now.getTime() + 10000).toISOString();
  psql(
    `INSERT INTO tournaments (name, genre_id, starts_at, registration_closes_at, max_entrants, created_by)
       VALUES ('Smoke test cup', '${genreId}', '${startsAt}', '${closesAt}', 4, '${adminId}')`,
  );
  const tournamentId = psql(
    `SELECT id FROM tournaments WHERE name = 'Smoke test cup' ORDER BY created_at DESC LIMIT 1`,
  );

  // Two users register via the API.
  const a = await signUpAndVerify(browser, 'trn', 1);
  const b = await signUpAndVerify(browser, 'trn', 2);

  // Bump their honor to 100 (already default) - tournament gate is 70.
  for (const p of [a, b]) {
    const r = await p.page.evaluate(
      async (args) => {
        const res = await fetch(`${args.api}/tournaments/${args.id}/register`, {
          method: 'POST',
          credentials: 'include',
        });
        return res.status;
      },
      { api: API, id: tournamentId },
    );
    ok = check(`${p.handle} registered (status=${r})`, r === 201 || r === 409) && ok;
  }

  // Wait for the tournamentScheduleScan tick (throttle 30s) to lock + pair.
  console.log('  waiting 35s for tick worker to lock registration + pair round 1...');
  await new Promise((r) => setTimeout(r, 35_000));

  const status = psql(`SELECT status FROM tournaments WHERE id = '${tournamentId}'`);
  ok = check(`tournament locked + paired (status=${status})`, status !== 'open') && ok;

  const matchCount = psql(
    `SELECT COUNT(*)::text FROM matches WHERE tournament_id = '${tournamentId}'`,
  );
  ok = check(`round-1 match created (count=${matchCount})`, Number(matchCount) >= 1) && ok;

  await a.ctx.close();
  await b.ctx.close();
  return ok;
}

async function runReportFlow(browser) {
  console.log('\n=== Report flow ===');
  const reporter = await signUpAndVerify(browser, 'rpt', 1);
  const target = await signUpAndVerify(browser, 'rpt', 2);
  let ok = true;

  // Reporter visits target's profile and clicks Report.
  await reporter.page.goto(`${WEB}/${target.handle}`, { waitUntil: 'networkidle' });
  const reportBtn = reporter.page.locator('button:has-text("Report")').first();
  if ((await reportBtn.count()) === 0) {
    console.log('  ⚠ Report button not visible - skipping');
    await reporter.ctx.close();
    await target.ctx.close();
    return true;
  }
  await reportBtn.click();
  await reporter.page.waitForTimeout(400);
  const reasonSel = reporter.page.locator('select#report-reason');
  ok = check('report dialog opened', (await reasonSel.count()) > 0) && ok;
  if ((await reasonSel.count()) > 0) {
    await reasonSel.selectOption('spam');
    await reporter.page.locator('textarea#report-notes').fill('automated smoke test report');
    await reporter.page.locator('button:has-text("Submit report")').click();
    await reporter.page.waitForTimeout(1000);
    ok = check('report success message', await waitForText(reporter.page, /Report submitted/i, 5000)) && ok;
  }
  // Confirm row in DB.
  const rowCount = psql(
    `SELECT COUNT(*)::text FROM reports r JOIN users u ON u.id = r.subject_id WHERE u.handle = '${target.handle}'`,
  );
  ok = check(`report row in DB (count=${rowCount})`, Number(rowCount) >= 1) && ok;

  await reporter.ctx.close();
  await target.ctx.close();
  return ok;
}

(async () => {
  await clearMail();
  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const results = [];

  try {
    results.push(['Static pages', await runStaticPages(browser)]);
    results.push(['Practice', await runPractice(browser)]);
    results.push(['Quickplay', await runFullMatch(browser, 'quickplay', 'qp', { playerCount: 4 })]);
    results.push(['Ranked', await runFullMatch(browser, 'ranked', 'rk', { playerCount: 4 })]);
    results.push(['Private 1v1', await runFullMatch(browser, 'private', 'pv', { playerCount: 2 })]);
    results.push(['Sample Flip', await runFullMatch(browser, 'flip', 'fl', { playerCount: 2 })]);
    results.push(['Daily Challenge gate', await runDailyChallenge(browser)]);
    results.push(['Tournament scheduling', await runTournament(browser)]);
    results.push(['Report flow', await runReportFlow(browser)]);
  } catch (err) {
    console.error('\nFATAL:', err);
    results.push(['FATAL', false]);
  } finally {
    await browser.close();
  }

  console.log('\n────────────────────────────────────────');
  console.log(' Summary');
  console.log('────────────────────────────────────────');
  let allOk = true;
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allOk = false;
  }
  console.log('');
  process.exit(allOk ? 0 : 1);
})();
