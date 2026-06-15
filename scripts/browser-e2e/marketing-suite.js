// Prod Battle marketing suite: records one clean clip per feature for a
// promo video. Each scene runs in its own browser context with its own
// recordVideo, and is independently guarded - one scene failing never kills
// the others. Premium polish: a visible cursor, smooth mouse moves, real
// beat audio (live waveforms), and a richly-seeded backdrop (run
// scripts/seed.ts --with-demo and scripts/seed-marketing.ts first).
//
// Run via the playwright skill (bundles Chromium):
//   cd ~/.claude/skills/playwright-skill
//   node run.js /home/bram/work/producer-battle/prod-battle-api/scripts/browser-e2e/marketing-suite.js
//
// Output: /home/bram/work/producer-battle/marketing/clips/<scene>.webm + stills.
// Helpers are inlined (the skill copies this file to its own dir, breaking
// relative requires).

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// ─── Config ─────────────────────────────────────────────────────────────────
const WEB = process.env.PB_WEB ?? 'http://localhost:5173';
const API = process.env.PB_API ?? 'http://localhost:8080';
const MAIL = process.env.PB_MAIL ?? 'http://localhost:8025';
const ROOT = '/home/bram/work/producer-battle/marketing';
const OUT = path.join(ROOT, 'clips');
const SHOTS = path.join(ROOT, 'stills');
const AUDIO = path.join(ROOT, 'audio');
// Orientation: default to vertical 9:16 for TikTok / Reels / YouTube Shorts
// (the dominant producer-discovery channels). Set PB_LANDSCAPE=1 to record the
// old 16:9 desktop clips instead. Vertical uses a phone-width viewport so the
// app's mobile-responsive layout renders, then scales up to a clean 1080x1920.
const LANDSCAPE = process.env.PB_LANDSCAPE === '1';
const VIDEO = LANDSCAPE ? { width: 1280, height: 800 } : { width: 1080, height: 1920 };
const VIEWPORT = LANDSCAPE ? { width: 1280, height: 800 } : { width: 540, height: 960 };
const BEATS = [1, 2, 3, 4].map((i) => path.join(AUDIO, `beat${i}.wav`));
const BEAT_LONG = path.join(AUDIO, 'beat-long.wav'); // 96s, for the Daily Challenge 90s minimum

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// Only scenes named here run; pass a comma list via PB_SCENES to subset.
const ONLY = (process.env.PB_SCENES ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// ─── Low-level helpers ───────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psql(sql) {
  return execSync(
    `docker exec producer-battle-postgres-1 psql -U prodbattle -d prod_battle -tA -c ${JSON.stringify(sql)}`,
  )
    .toString()
    .trim();
}

// The match websocket authenticates by matching the pb_anon cookie against
// users.anon_id (see src/ws/index.ts ensureGuestUser). Fresh signups have a
// null anon_id, so the server closes the match socket (4003) and the player
// is never seated. Bind the account to the browser's real pb_anon cookie so
// the ws handshake resolves + seats them.
async function bindAnon(ctx, handle) {
  const cookies = await ctx.cookies();
  const pb = cookies.find((c) => c.name === 'pb_anon')?.value;
  if (pb) psql(`UPDATE users SET anon_id='${pb}' WHERE handle='${handle}'`);
  return pb ?? null;
}

// A visible cursor + click ripple, injected into every page so recordings
// read clearly (Playwright captures no real pointer).
const CURSOR_INIT = `
(() => {
  if (window.__pwCursor) return; window.__pwCursor = true;
  const add = () => {
    const dot = document.createElement('div');
    dot.id = '__pw_cursor';
    dot.style.cssText = 'position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(168,85,247,.45);border:2px solid #fff;box-shadow:0 0 12px rgba(168,85,247,.9);pointer-events:none;transition:transform .08s ease;left:-100px;top:-100px';
    document.body.appendChild(dot);
    window.addEventListener('mousemove', (e) => { dot.style.left = e.clientX+'px'; dot.style.top = e.clientY+'px'; }, true);
    window.addEventListener('mousedown', () => { dot.style.transform='scale(.6)'; }, true);
    window.addEventListener('mouseup', () => { dot.style.transform='scale(1)'; }, true);
  };
  if (document.body) add(); else window.addEventListener('DOMContentLoaded', add);
})();
`;

// Baked-in marketing captions: a bold hook (upper third) + a CTA pill (lower
// safe zone), high-contrast per short-form best practice. Persisted via
// localStorage so the caption survives in-scene navigations (addInitScript
// re-runs and re-applies it on every page load).
const CAPTION_INIT = `
(() => {
  if (window.__pbCapInit) return; window.__pbCapInit = true;
  const mk = () => {
    if (document.getElementById('__pb_cap')) return;
    const wrap = document.createElement('div');
    wrap.id = '__pb_cap';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:Inter,system-ui,-apple-system,sans-serif';
    wrap.innerHTML = \`
      <div id="__pb_hook" style="position:absolute;top:7%;left:4%;right:4%;text-align:center;font-weight:800;font-size:33px;line-height:1.15;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.85);letter-spacing:-.5px;background:rgba(8,8,14,.62);padding:14px 16px;border-radius:16px;opacity:0;transition:opacity .35s"></div>
      <div id="__pb_cta" style="position:absolute;bottom:7.5%;left:8%;right:8%;text-align:center;font-weight:700;font-size:23px;color:#fff;background:linear-gradient(90deg,#a855f7,#7c3aed);padding:13px 16px;border-radius:16px;box-shadow:0 8px 28px rgba(124,58,237,.5);opacity:0;transition:opacity .35s"></div>\`;
    document.body.appendChild(wrap);
    const apply = () => {
      const h = document.getElementById('__pb_hook'), c = document.getElementById('__pb_cta');
      const hv = localStorage.getItem('__pb_hook') || '', cv = localStorage.getItem('__pb_cta') || '';
      if (h) { h.textContent = hv; h.style.opacity = hv ? '1' : '0'; }
      if (c) { c.textContent = cv; c.style.opacity = cv ? '1' : '0'; }
    };
    window.__pbCaption = (hook, cta) => {
      try { localStorage.setItem('__pb_hook', hook || ''); localStorage.setItem('__pb_cta', cta || ''); } catch {}
      apply();
    };
    apply();
  };
  if (document.body) mk(); else window.addEventListener('DOMContentLoaded', mk);
})();
`;

async function newCtx(browser, { record } = { record: true }) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    ...(record ? { recordVideo: { dir: OUT, size: VIDEO } } : {}),
  });
  await ctx.addInitScript(CURSOR_INIT);
  await ctx.addInitScript(CAPTION_INIT);
  return ctx;
}

// Set the on-screen hook + CTA for the current scene (persists across that
// scene's navigations). Call once after the first page load.
async function setCaption(page, hook, cta) {
  await page
    .evaluate(([h, c]) => window.__pbCaption?.(h, c), [hook, cta])
    .catch(() => {});
}

// Move the pointer smoothly to a locator and click it (so the cursor travels
// on camera). Falls back to a plain click if the box can't be measured.
async function move(page, locator) {
  try {
    const el = locator.first();
    await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    const box = await el.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  } catch {}
}
async function click(page, locator) {
  await move(page, locator);
  await sleep(220);
  await locator.first().click().catch(() => {});
}
const dwell = (page, ms) => page.waitForTimeout(ms);

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
}

// Slow auto-scroll so static pages have motion in the clip.
async function tour(page, ms = 4000) {
  const steps = Math.max(1, Math.floor(ms / 400));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 320);
    await sleep(400);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(600);
}

// ─── Auth helpers ────────────────────────────────────────────────────────────
async function clearMail() {
  await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE' }).catch(() => {});
}
async function findVerifyLink(toEmail, attempts = 60) {
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
    await sleep(500);
  }
  throw new Error(`No verify mail for ${toEmail}`);
}

// Sign up + verify a real account with the given handle. recordSignup=true
// keeps deliberate dwell so the register clip reads nicely.
async function signUp(
  browser,
  handle,
  { record = false, recordSignup = false, paid = false, accent = null, arRole = false } = {},
) {
  const ctx = await newCtx(browser, { record });
  const page = await ctx.newPage();
  const email = `${handle}@test.local`;
  const password = 'password123';
  await page.goto(`${WEB}/auth/sign-up`, { waitUntil: 'networkidle' });
  await page.locator('input[placeholder*="producer-alias"]').first().waitFor({ timeout: 15000 });
  const accept = page.locator('button', { hasText: /^(accept|allow|got it|ok)\b/i }).first();
  if ((await accept.count()) > 0) await accept.click().catch(() => {});

  if (recordSignup) await dwell(page, 800);
  await page.locator('input[placeholder*="producer-alias"]').first().fill(handle);
  if (recordSignup) await dwell(page, 500);
  await page.locator('input[type="email"]').first().fill(email);
  if (recordSignup) await dwell(page, 500);
  await page.locator('input[type="password"]').first().fill(password);
  if (recordSignup) await dwell(page, 800);

  for (let attempt = 0; attempt < 2; attempt++) {
    const fired = page
      .waitForResponse((r) => r.url().includes('/auth/sign-up/email'), { timeout: 8000 })
      .catch(() => null);
    await click(page, page.locator('button[type="submit"]'));
    if (await fired) break;
    await sleep(500);
  }
  if (recordSignup) await dwell(page, 1200); // "check your email" state

  // The account row exists now (signup POST fired). A paid session must be
  // paid BEFORE the verify link creates it - flipping the plan after login
  // leaves the cached session on the free tier. So set it here, pre-verify.
  if (paid) {
    const avatarUrl = `https://api.dicebear.com/9.x/thumbs/png?seed=${encodeURIComponent(handle)}&size=240`;
    psql(
      `UPDATE users SET plan='paid', avatar_url='${avatarUrl}'` +
        `${accent ? `, accent_color='${accent}'` : ''} WHERE handle='${handle}'`,
    );
  }
  // A&R role must also be set before the verify link creates the session
  // (role is captured at session creation, like the plan).
  if (arRole) {
    const avatarUrl = `https://api.dicebear.com/9.x/thumbs/png?seed=${encodeURIComponent(handle)}&size=240`;
    psql(`UPDATE users SET role='ar', avatar_url='${avatarUrl}' WHERE handle='${handle}'`);
  }

  const link = await findVerifyLink(email);
  await page.goto(link, { waitUntil: 'networkidle' });
  await dwell(page, 1200);
  if (!page.url().includes('/play')) {
    await page.goto(`${WEB}/auth/sign-in`, { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await click(page, page.locator('button[type="submit"]'));
    await page.waitForURL('**/play', { timeout: 10000 }).catch(() => {});
  }
  // Bind anon_id so the match websocket will seat this account (registered
  // users are otherwise rejected by the ws auth and never join the roster).
  await bindAnon(ctx, handle);
  return { ctx, page, handle, email };
}

// ─── Match helpers ───────────────────────────────────────────────────────────
// Drive ready/start through a credentialed fetch. The lobby's own ready/start
// buttons post WITHOUT credentials (a raw fetch in Lobby.tsx), so in this
// cross-origin dev setup (web:5173 -> api:8080) they send no cookie and the
// server can't resolve the player. The roster websocket still reflects the
// change live, so the lobby visibly updates. (submit/vote/chat go through the
// api-client, which DOES send credentials, so those stay as UI actions.)
async function roomAction(page, code, action, handle) {
  return page
    .evaluate(
      async ({ api, code, action, handle }) => {
        const r = await fetch(`${api}/rooms/${code}/${action}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: handle }),
        });
        return r.status;
      },
      { api: API, code, action, handle },
    )
    .catch(() => -1);
}

// Load a file into the submit screen so its waveform renders on camera. The
// browser can't PUT to the staging S3 bucket from localhost, so we never click
// the real submit button (it would error); submissions are finalized via
// submitViaApi instead.
async function pickFile(page, beat) {
  await page.locator('input[type="file"]').first().setInputFiles(beat).catch(() => {});
  await page.waitForTimeout(1500);
}

// Real submission: pick a file and click the UI's Submit button, which
// presigns a PUT to MinIO, uploads the file, and finalizes the submission
// (which also fires the "all submitted -> advance" check). Works now that
// MinIO is in the compose stack and the API presigns browser-reachable URLs.
async function realSubmit(page, beat) {
  await page.locator('input[type="file"]').first().setInputFiles(beat).catch(() => {});
  await page.waitForTimeout(1500);
  const btn = page.locator('button[aria-label="Submit track"]').first();
  if (await btn.count()) await btn.click().catch(() => {});
  await page.waitForTimeout(3000); // presigned PUT to MinIO + finalize
}

// Finalize a submission through the API. The server derives audioUrl =
// publicUrl(key); the object need not exist (rms/fingerprint failures are
// tolerated). This also fires the "all submitted -> advance" check.
async function submitViaApi(page, code, handle, key, title) {
  return page
    .evaluate(
      async ({ api, code, handle, key, title }) => {
        const r = await fetch(`${api}/rooms/${code}/submission`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: handle, key, title, durationSec: 8 }),
        });
        return r.status;
      },
      { api: API, code, handle, key, title },
    )
    .catch(() => -1);
}

// Repoint a match's submissions at same-origin beats so the vote + results
// screens play audio + draw waveforms (signUrl passes non-bucket URLs through).
function repointAudio(code) {
  psql(
    `UPDATE submissions SET audio_url='http://localhost:5173/promo/beat' || (1 + (abs(hashtext(id::text)) % 8)) || '.wav' WHERE match_id=(SELECT id FROM matches WHERE room_code='${code}')`,
  );
}

// All headless contexts share one canvas/screen fingerprint, so the vote
// route's sock-puppet guard flags every voter as the submitter's device and
// drops the ballots. Clear the seated players' fingerprints so votes count.
function clearFingerprints(code) {
  psql(
    `UPDATE users SET device_fingerprints='[]'::jsonb WHERE id IN (SELECT user_id FROM match_players WHERE match_id=(SELECT id FROM matches WHERE room_code='${code}'))`,
  );
}

// Remove a previously-proposed (user) genre so the propose clip can recreate
// it cleanly - genre slugs are unique, so a re-run would otherwise error with
// "already exists".
function deleteUserGenre(slug) {
  try {
    psql(`DELETE FROM genre_votes WHERE genre_id IN (SELECT id FROM genres WHERE slug='${slug}' AND kind='user')`);
    psql(`DELETE FROM genres WHERE slug='${slug}' AND kind='user'`);
  } catch {
    /* genre in use (has matches) - leave it; the scene will pick another name */
  }
}

// (votes are cast via the API below, not the UI, for reliable phase timing.)
// Cast a player's votes through the API. The UI's star buttons only accept
// input during the (timed) vote phase, which is fiddly to hit on camera; the
// vote endpoint accepts votes across the reveal/vote window. Scores descend
// (5,4,3) per entry so the results screen has a clear ranking. Posting the
// last voter's ballot triggers maybeAdvanceAfterVote -> results.
async function voteViaApi(page, code, handle) {
  return page
    .evaluate(
      async ({ api, code, handle }) => {
        const rev = await fetch(`${api}/matches/${code}/reveal?user=${encodeURIComponent(handle)}`, {
          credentials: 'include',
        })
          .then((r) => r.json())
          .catch(() => ({}));
        // The reveal endpoint returns { items: [...] }.
        const list = Array.isArray(rev) ? rev : Array.isArray(rev.items) ? rev.items : [];
        const others = list.filter((i) => !i.isOwn);
        const votes = others.map((i, idx) => ({ submissionId: i.submissionId, score: 5 - (idx % 3) }));
        if (!votes.length) return { status: 0, votes: 0 };
        const r = await fetch(`${api}/rooms/${code}/vote`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: handle, votes }),
        });
        return { status: r.status, votes: votes.length };
      },
      { api: API, code, handle },
    )
    .catch(() => ({ status: -1, votes: 0 }));
}
async function waitForText(page, re, ms = 35000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const html = await page.content();
    if (re.test(html)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Run a full match from players[0]'s (the hero's) recorded POV: others join,
// emoji banter in the lobby AND through every phase, ready -> start -> sample
// kit -> upload -> blind vote -> results. `code` is the host's room code.
async function orchestrateMatch(players, code, tag) {
  const hero = players[0];
  const n = players.length;
  const say = async (pi, msg) => {
    if (pi >= n) return;
    const pg = players[pi].page;
    const input = pg
      .locator('input[aria-label="Chat message"], input[placeholder*="Say something"]')
      .first();
    if ((await input.count()) === 0) return;
    if (pi === 0) await move(hero.page, input);
    await input.fill(msg);
    await input.press('Enter').catch(() => {});
    await dwell(hero.page, 650);
  };

  // Others join (+ take a seat if asked).
  for (let i = 1; i < n; i++) {
    await players[i].page.goto(`${WEB}/room/${code}`, { waitUntil: 'networkidle' });
    const seat = players[i].page
      .locator('button', { hasText: /take a seat|join match|join room|^join$|sit/i })
      .first();
    if ((await seat.count()) > 0) await seat.click().catch(() => {});
    await dwell(players[i].page, 700);
  }
  await waitForText(hero.page, new RegExp(`${n}\\s*in`), 15000).catch(() => {});
  await dwell(hero.page, 1200);
  await shot(hero.page, `${tag}-lobby`);

  // Lobby banter.
  const banter = [
    [0, 'lets get it 🔥'],
    [1, 'may the best flip win 😤'],
    [2, '808s loaded 🥁'],
    [3, 'gl all 🤝'],
  ];
  for (const [pi, msg] of banter) await say(pi, msg);
  await dwell(hero.page, 1200);
  await shot(hero.page, `${tag}-chat`);

  // Ready everyone via the credentialed API (lobby updates live over the
  // roster socket); then host starts (button press for the visual + the
  // credentialed call that actually fires the transition).
  for (const p of players) {
    const rb = p.page.locator('button[aria-label="Ready up"]').first();
    if (await rb.count()) await move(p.page, rb);
    await roomAction(p.page, code, 'ready', p.handle);
    await dwell(p.page, 400);
  }
  await dwell(hero.page, 1800);
  await shot(hero.page, `${tag}-ready`);
  const startBtn = hero.page.locator('button[aria-label="Start match"]').first();
  if (await startBtn.count()) await click(hero.page, startBtn).catch(() => {});
  await roomAction(hero.page, code, 'start', hero.handle);

  // Submit phase - audition the kit/loop, then everyone uploads for REAL
  // (presigned PUT to MinIO -> finalize, which advances the phase). Banter
  // keeps flowing.
  for (const p of players) await waitForText(p.page, /Drop your track/i, 35000);
  await dwell(hero.page, 1200);
  // Audition the source on camera: play the first audio element - a sample-kit
  // stem (battle) or the flip loop (sample flip), both served from MinIO.
  await hero.page
    .locator('audio')
    .first()
    .evaluate((el) => el.play().catch(() => {}))
    .catch(() => {});
  await dwell(hero.page, 2800);
  await shot(hero.page, `${tag}-kit`);
  await pickFile(hero.page, BEATS[0]); // hero loads a file (waveform draws on screen)
  await dwell(hero.page, 1800);
  await say(1, 'this kit is nasty 🤯');
  await say(2, 'cooking 🍳');
  for (let i = 1; i < n; i++) await realSubmit(players[i].page, BEATS[i % BEATS.length]);
  await say(Math.min(3, n - 1), 'submitted ✅ gl');
  await realSubmit(hero.page, BEATS[0]); // hero drops last, on camera
  await say(0, 'locked in 🔒🔥');
  await dwell(hero.page, 1200);

  // Blind vote. Reload the hero so the reveal re-fetches the playable audio,
  // dwell on the listen/score screen (waveforms), click stars if the vote UI
  // is up (visual), then cast everyone's ballots via the API -> results.
  await hero.page.goto(`${WEB}/room/${code}`, { waitUntil: 'networkidle' }).catch(() => {});
  await dwell(hero.page, 1500);
  await shot(hero.page, `${tag}-vote`);
  // Listen to each entry ONE AT A TIME: play it, then pause it before moving
  // to the next, so the waveforms never animate over each other.
  const toggles = hero.page.locator('button[aria-label="Play"], button[aria-label="Pause"]');
  const tc = await toggles.count();
  for (let i = 0; i < tc; i++) {
    await click(hero.page, toggles.nth(i)); // play entry i
    await dwell(hero.page, 2200);
    await toggles.nth(i).click().catch(() => {}); // pause before the next
    await dwell(hero.page, 350);
  }
  // Then score the entries.
  const stars = hero.page.locator('[aria-label="5 star"]');
  const sc = await stars.count();
  for (let i = 0; i < sc; i++) {
    await stars.nth(i).click().catch(() => {});
    await dwell(hero.page, 220);
  }
  await say(1, 'these are all heat 🔥');
  await say(Math.min(2, n - 1), 'tough vote 👀');
  clearFingerprints(code); // so the sock-puppet guard doesn't drop our ballots
  const voteResults = [];
  for (const p of players) voteResults.push(await voteViaApi(p.page, code, p.handle));
  console.log(`  votes [${tag}]:`, JSON.stringify(voteResults));

  // Results.
  await hero.page.goto(`${WEB}/room/${code}`, { waitUntil: 'networkidle' }).catch(() => {});
  await hero.page.locator('text=/Play again|takes it with|Results/i').first().waitFor({ timeout: 20000 }).catch(() => {});
  await dwell(hero.page, 2000);
  // Play the winning track on the results screen.
  const winPlay = hero.page.locator('button[aria-label="Play"]').first();
  if (await winPlay.count()) {
    await click(hero.page, winPlay);
    await dwell(hero.page, 3000);
  }
  await say(0, 'gg 🤝');
  await say(1, 'rematch? 😈');
  await dwell(hero.page, 2500);
  await shot(hero.page, `${tag}-results`);
}

// ─── Scene registry ──────────────────────────────────────────────────────────
const results = [];
async function scene(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log(`\n=== scene: ${name} ===`);
  let video = null;
  try {
    video = await fn();
    results.push({ name, ok: true, video });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: String(err && err.message) });
    console.error(`  ✗ ${name}:`, err && err.message);
  }
}
// Close a recorded context and rename its video to <scene>.webm.
async function finish(ctx, page, name) {
  const vid = page.video();
  await ctx.close();
  const p = vid ? await vid.path().catch(() => null) : null;
  if (p && fs.existsSync(p)) {
    const dest = path.join(OUT, `${name}.webm`);
    fs.renameSync(p, dest);
    return dest;
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  await clearMail();
  // Headless: each context's video is captured off-screen, so no windows
  // open on the host and multiple players can never overlap / steal focus.
  const browser = await chromium.launch({ headless: true, slowMo: 30 });
  const stamp = String(Date.now()).slice(-5);

  // S1 - Register (fresh signup + email verify), recorded start to finish.
  await scene('register', async () => {
    const h = `rookie${stamp}`;
    const { ctx, page } = await signUp(browser, h, { record: true, recordSignup: true });
    await page.goto(`${WEB}/play`, { waitUntil: 'networkidle' }).catch(() => {});
    await setCaption(page, 'Make beats. Battle live. Get ranked.', 'Sign up free at prodbattle.com');
    await dwell(page, 2500);
    await shot(page, 'register');
    return finish(ctx, page, 'register');
  });

  // S2 - A rich, lived-in profile (public, no login needed).
  await scene('profile', async () => {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/polystalgia`, { waitUntil: 'networkidle' });
    await setCaption(page, 'Every beat you make lives on your profile.', 'Build your rep at prodbattle.com');
    await dwell(page, 2500);
    await shot(page, 'profile');
    await tour(page, 5000);
    return finish(ctx, page, 'profile');
  });

  // S3 - Leaderboard: browse the per-genre boards + switch Ranked/Quick Play.
  await scene('leaderboard', async () => {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/leaderboard`, { waitUntil: 'networkidle' });
    await setCaption(page, 'One ranking per genre. Climb yours.', 'Rank up at prodbattle.com');
    await dwell(page, 2200);
    await shot(page, 'leaderboard');
    const modeSel = page.locator('select').nth(0);
    const genreSel = page.locator('select').nth(1);
    // Click through a few genre boards (each has its own ranked roster).
    for (const g of ['phonk', 'amapiano', 'techno', 'hip-hop-trap']) {
      await move(page, genreSel);
      await genreSel.selectOption({ value: g }).catch(() => {});
      await dwell(page, 1800);
    }
    await shot(page, 'leaderboard-genre');
    // Switch to the Quick Play board, then back to Ranked / all genres.
    await move(page, modeSel);
    await modeSel.selectOption({ value: 'quickplay' }).catch(() => {});
    await dwell(page, 2200);
    await shot(page, 'leaderboard-quickplay');
    await move(page, modeSel);
    await modeSel.selectOption({ value: 'ranked' }).catch(() => {});
    await genreSel.selectOption({ value: '' }).catch(() => {});
    await dwell(page, 2000);
    return finish(ctx, page, 'leaderboard');
  });

  // S4 - The feed (fresh submissions, waveforms, listen before you vote).
  await scene('feed', async () => {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/feed`, { waitUntil: 'networkidle' });
    await setCaption(page, "Hear today's winning beats.", 'Discover free at prodbattle.com');
    await dwell(page, 2500);
    const play = page.locator('button[aria-label*="lay"], button:has-text("Play")').first();
    if ((await play.count()) > 0) await click(page, play);
    await dwell(page, 2000);
    await shot(page, 'feed');
    await tour(page, 5000);
    return finish(ctx, page, 'feed');
  });

  // S5 - Browse open lobbies: a producer hosts a public room, then a visitor
  // browses /lobbies, filters, and clicks in.
  await scene('lobbies', async () => {
    // Host a public room so the list has a live, clickable lobby.
    const host = await signUp(browser, `host${stamp}`);
    await host.page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
    const prc = host.page
      .locator('div', { has: host.page.getByText('Private Room', { exact: true }) })
      .first();
    await prc.locator('select').first().selectOption({ value: 'phonk' }).catch(() => {});
    await host.page.waitForTimeout(400);
    await prc.locator('input[type="checkbox"]').first().check().catch(() => {});
    await prc.locator('button:has-text("Host a room")').first().click().catch(() => {});
    await host.page.waitForURL('**/room/**', { timeout: 12000 }).catch(() => {});

    // Visitor browses the lobby list (recorded).
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/lobbies`, { waitUntil: 'networkidle' });
    await setCaption(page, 'Jump into a live battle right now.', 'Play free at prodbattle.com');
    await dwell(page, 2500);
    await shot(page, 'lobbies');
    // Click a couple of the mode filter chips.
    for (const f of ['Private', 'All']) {
      const btn = page.locator('button', { hasText: new RegExp(`^${f}$`, 'i') }).first();
      if ((await btn.count()) > 0) {
        await click(page, btn);
        await dwell(page, 1500);
      }
    }
    // Hover + click into the live lobby.
    const row = page.locator('a[href*="/room/"]').first();
    if ((await row.count()) > 0) {
      await move(page, row);
      await dwell(page, 1200);
      await click(page, row);
      await page.waitForURL('**/room/**', { timeout: 8000 }).catch(() => {});
      await dwell(page, 2500);
      await shot(page, 'lobbies-joined');
    }
    const dest = await finish(ctx, page, 'lobbies');
    await host.ctx.close().catch(() => {});
    return dest;
  });

  // S6 - Tournaments (brackets, weekly winners). The page requires auth, so
  // sign in first, then browse upcoming + past tournaments.
  await scene('tournaments', async () => {
    const { ctx, page } = await signUp(browser, `cup${stamp}`, { record: true });
    // Resolve the detail URLs directly (TanStack Link clicks are flaky to
    // navigate headless; a direct goto reliably opens the detail page).
    const cupId = psql("SELECT id FROM tournaments WHERE name='Amapiano Cup #3' LIMIT 1");
    const openId = psql("SELECT id FROM tournaments WHERE name='Phonk Throwdown #7' LIMIT 1");

    await page.goto(`${WEB}/tournaments`, { waitUntil: 'networkidle' });
    await setCaption(page, 'Weekly tournaments. Real brackets.', 'Compete at prodbattle.com');
    await dwell(page, 2500);
    await shot(page, 'tournaments');
    await tour(page, 2500);

    // Full bracket of a finished tournament (quarters -> semis -> final).
    if (cupId) {
      await page.goto(`${WEB}/tournaments/${cupId}`, { waitUntil: 'networkidle' });
      await dwell(page, 2500);
      await shot(page, 'tournament-bracket');
      await tour(page, 4000);
    }

    // Upcoming tournament: open it and register.
    if (openId) {
      await page.goto(`${WEB}/tournaments/${openId}`, { waitUntil: 'networkidle' });
      await dwell(page, 2000);
      await shot(page, 'tournament-open');
      const reg = page.locator('button', { hasText: /^Register$/i }).first();
      if ((await reg.count()) > 0) {
        await click(page, reg);
        await dwell(page, 2500);
        await shot(page, 'tournament-registered');
      }
    }
    return finish(ctx, page, 'tournaments');
  });

  // S7 - Propose a new genre (logged-in).
  await scene('genre-propose', async () => {
    const h = `curator${stamp}`;
    const genreName = 'Future Funk';
    deleteUserGenre('future-funk'); // so the proposal completes cleanly on re-runs
    const { ctx, page } = await signUp(browser, h, { record: true });
    await page.goto(`${WEB}/genres/propose`, { waitUntil: 'networkidle' });
    await setCaption(page, 'Your genre. Your rules.', 'Shape the meta at prodbattle.com');
    await dwell(page, 1500);
    const name = page.locator('input[placeholder="Future funk"]').first();
    if ((await name.count()) > 0) {
      await move(page, name);
      await name.fill(genreName);
      await dwell(page, 900);
    }
    // Toggle a few stem types.
    for (const stem of ['kick', 'snare', 'hihat', '808', 'bass']) {
      const b = page.locator('button', { hasText: new RegExp(`^${stem}$`, 'i') }).first();
      if ((await b.count()) > 0) {
        await click(page, b);
        await dwell(page, 350);
      }
    }
    await dwell(page, 800);
    await shot(page, 'genre-propose');
    await click(page, page.locator('button[type="submit"]'));
    // Successful proposal redirects to /genres; land there and show the result.
    await page.waitForURL('**/genres', { timeout: 12000 }).catch(() => {});
    await dwell(page, 2500);
    await shot(page, 'genre-propose-done');
    return finish(ctx, page, 'genre-propose');
  });

  // S8 - Sample Flip: show the mode card, then a real 2-producer flip battle
  // (one loop, everyone flips it) with emoji chat throughout.
  await scene('sample-flip', async () => {
    const names = ['flux', 'reverb'].map((nm) => `${nm}${stamp}`);
    const players = [];
    for (let i = 0; i < names.length; i++) {
      const p = await signUp(browser, names[i], { record: i === 0, paid: true, accent: i === 0 ? '#22d3ee' : null });
      players.push(p);
    }
    const hero = players[0];

    await hero.page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
    await setCaption(hero.page, 'Same loop. Who flips it best?', 'Flip it at prodbattle.com');
    const card = hero.page
      .locator('div', { has: hero.page.getByText('Sample Flip', { exact: true }) })
      .first();
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await dwell(hero.page, 2000);
    await shot(hero.page, 'sample-flip-card');
    await click(hero.page, card.locator('button', { hasText: /flip it/i }));
    await hero.page.waitForURL('**/room/**', { timeout: 12000 });
    const code = hero.page.url().split('/').pop().split('?')[0];
    console.log('  flip room:', code);

    await orchestrateMatch(players, code, 'sample-flip');

    const dest = await finish(hero.ctx, hero.page, 'sample-flip');
    for (let i = 1; i < players.length; i++) await players[i].ctx.close().catch(() => {});
    return dest;
  });

  // S9 - Daily Challenge (supporter perk): enter + drop a beat.
  await scene('daily-challenge', async () => {
    const h = `daily${stamp}`;
    const { ctx, page } = await signUp(browser, h, { record: true, paid: true, accent: '#a855f7' });
    await page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
    await setCaption(page, 'One kit. One day. One winner.', "Today's challenge at prodbattle.com");
    await dwell(page, 2000);
    await shot(page, 'daily-card');
    const card = page.locator('button:has-text("Daily Challenge")').first();
    if ((await card.count()) > 0) {
      await click(page, card);
      await page.waitForURL('**/room/**', { timeout: 12000 }).catch(() => {});
      await dwell(page, 1500);
      const enter = page.locator('button', { hasText: /enter today/i }).first();
      if ((await enter.count()) > 0) {
        await click(page, enter);
        await dwell(page, 2000);
      }
      await shot(page, 'daily-room');
      await pickFile(page, BEAT_LONG); // daily requires >= 90s tracks
      // The upload zone + waveform preview sit below the kit - scroll into frame.
      await page
        .getByText(/Submit your track/i)
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await dwell(page, 2200);
      await shot(page, 'daily-picked');
      // Real upload to MinIO, then show the submitted state.
      await page.locator('button[aria-label="Submit track"]').first().click().catch(() => {});
      await dwell(page, 3500);
      await shot(page, 'daily-submitted');
    }
    return finish(ctx, page, 'daily-challenge');
  });

  // S10 - The battle: 4 paid producers, emoji chat in the lobby, then a full
  // ranked match (kit -> upload -> blind vote -> results). Hero is recorded.
  await scene('battle', async () => {
    const names = ['noctis', 'vellum', 'sable', 'orin'].map((n) => `${n}${stamp}`);
    const players = [];
    for (let i = 0; i < names.length; i++) {
      // All paid so emoji chat is unlocked for everyone in the room.
      const p = await signUp(browser, names[i], { record: i === 0, paid: true, accent: i === 0 ? '#a855f7' : null });
      players.push(p);
    }
    const hero = players[0];

    // Host starts a ranked match.
    await hero.page.goto(`${WEB}/play`, { waitUntil: 'networkidle' });
    await setCaption(hero.page, 'Same sample kit. Skill, not gear.', 'Battle now at prodbattle.com');
    const rcard = hero.page
      .locator('div', { has: hero.page.getByText('Ranked', { exact: true }) })
      .first();
    // A non-phonk genre, so the centrepiece match isn't the same genre as
    // everything else. Fall back to the 2nd option if the value is missing.
    await rcard
      .locator('select')
      .first()
      .selectOption({ value: 'drum-and-bass' })
      .catch(async () => {
        await rcard.locator('select').first().selectOption({ index: 1 }).catch(() => {});
      });
    await dwell(hero.page, 600);
    await click(hero.page, rcard.locator('button:has-text("Play Ranked")'));
    await hero.page.waitForURL('**/room/**', { timeout: 12000 });
    const code = hero.page.url().split('/').pop().split('?')[0];
    console.log('  battle room:', code);

    await orchestrateMatch(players, code, 'battle');

    const dest = await finish(hero.ctx, hero.page, 'battle');
    for (let i = 1; i < players.length; i++) await players[i].ctx.close().catch(() => {});
    return dest;
  });

  // S11 - Most Scouted: producers ranked by A&R interest (public).
  await scene('most-scouted', async () => {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/scouted`, { waitUntil: 'networkidle' });
    await setCaption(page, 'Get scouted by real A&R.', 'Get noticed at prodbattle.com');
    await dwell(page, 2500);
    await shot(page, 'most-scouted');
    await tour(page, 4000);
    return finish(ctx, page, 'most-scouted');
  });

  // S12 - A&R Briefs board (public list).
  await scene('briefs', async () => {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/briefs`, { waitUntil: 'networkidle' });
    await setCaption(page, 'Labels post briefs. You make the beat.', 'Win a placement at prodbattle.com');
    await dwell(page, 2500);
    await shot(page, 'briefs');
    // Open the first brief to show the detail + entries.
    const first = page.locator('button', { hasText: /BPM|closes|by @/i }).first();
    if ((await first.count()) > 0) {
      await click(page, first);
      await dwell(page, 2500);
      await shot(page, 'briefs-detail');
    }
    return finish(ctx, page, 'briefs');
  });

  // S13 - A&R dashboard: a scout discovers producers, plays drops, picks a
  // track, browses briefs.
  await scene('ar-dashboard', async () => {
    const h = `scout${stamp}`;
    const { ctx, page } = await signUp(browser, h, { record: true, arRole: true });
    await page.goto(`${WEB}/ar`, { waitUntil: 'networkidle' });
    await setCaption(page, 'Real A&R scout producers here.', 'Get discovered at prodbattle.com');
    await dwell(page, 2500);
    await shot(page, 'ar-producers');
    // Open a producer drawer and give a track an A&R Pick. Rows are clickable
    // divs (cursor-pointer), not buttons.
    const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' }).first();
    if ((await row.count()) > 0) {
      await click(page, row);
      await dwell(page, 2500);
      await shot(page, 'ar-producer-drawer');
      // Audition a track, then click a 5-star A&R Pick.
      const play = page.locator('button[aria-label="Play"]').first();
      if ((await play.count()) > 0) {
        await click(page, play);
        await dwell(page, 2200);
      }
      const star = page.locator('[aria-label="5 star"]').first();
      if ((await star.count()) > 0) {
        await click(page, star);
        await dwell(page, 1500);
        await shot(page, 'ar-pick');
      }
      const close = page.locator('button[aria-label="Close"], button:has-text("✕")').first();
      if ((await close.count()) > 0) await close.click().catch(() => {});
    }
    // Drops tab.
    const dropsTab = page.locator('button', { hasText: /^Drops$/ }).first();
    if ((await dropsTab.count()) > 0) {
      await click(page, dropsTab);
      await dwell(page, 2500);
      await shot(page, 'ar-drops');
    }
    // Briefs tab.
    const briefsTab = page.locator('button', { hasText: /^Briefs$/ }).first();
    if ((await briefsTab.count()) > 0) {
      await click(page, briefsTab);
      await dwell(page, 2500);
      await shot(page, 'ar-briefs');
    }
    return finish(ctx, page, 'ar-dashboard');
  });

  // S14 - Friends: producer A adds producer B, B accepts in their inbox.
  await scene('friends', async () => {
    const a = await signUp(browser, `nova${stamp}`, { record: true });
    const b = await signUp(browser, `pixel${stamp}`);
    // A visits B's profile and sends a friend request.
    await a.page.goto(`${WEB}/${b.handle}`, { waitUntil: 'networkidle' });
    await setCaption(a.page, 'Find your producer crew.', 'Connect at prodbattle.com');
    await dwell(a.page, 2000);
    await shot(a.page, 'friends-profile');
    const add = a.page.locator('button:has-text("Add friend")').first();
    if ((await add.count()) > 0) {
      await click(a.page, add);
      await dwell(a.page, 1500);
      await shot(a.page, 'friends-requested');
    }
    // B accepts in their inbox.
    await b.page.goto(`${WEB}/inbox`, { waitUntil: 'networkidle' });
    await dwell(b.page, 1500);
    const accept = b.page.locator('button:has-text("Accept")').first();
    if ((await accept.count()) > 0) await accept.click().catch(() => {});
    await dwell(b.page, 1500);
    // A sees the friendship in their inbox.
    await a.page.goto(`${WEB}/inbox`, { waitUntil: 'networkidle' });
    await dwell(a.page, 2500);
    await shot(a.page, 'friends-inbox');
    const dest = await finish(a.ctx, a.page, 'friends');
    await b.ctx.close().catch(() => {});
    return dest;
  });

  // S15 - A&R advantage (producer POV): a label scout reaches out, the request
  // lands in the producer's inbox, they accept, and their work carries the
  // "A&R's Choice" badge in the feed. This is the producer-facing payoff of
  // the whole A&R layer - a reason to keep submitting good beats.
  await scene('ar-advantage', async () => {
    // The producer we follow (recorded).
    const prod = await signUp(browser, `prospect${stamp}`, { record: true });
    const prodId = psql(`SELECT id FROM users WHERE handle='${prod.handle}'`);
    // A label scout (helper, not recorded) reaches out via the A&R API.
    const scout = await signUp(browser, `label${stamp}`, { arRole: true });
    const reachStatus = await scout.page.evaluate(
      async ({ api, prodId }) => {
        const r = await fetch(`${api}/ar/contact/${prodId}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message:
              "Loved your last flip - we're scouting for an upcoming compilation. Open to a chat?",
          }),
        });
        return r.status;
      },
      { api: API, prodId },
    );
    console.log(`ar reach-out [ar-advantage]: ${reachStatus}`);
    await scout.ctx.close().catch(() => {});

    // The producer opens their inbox and finds the label's reach-out.
    await prod.page.goto(`${WEB}/inbox`, { waitUntil: 'networkidle' });
    await setCaption(prod.page, 'A label just landed in your inbox.', 'Get scouted at prodbattle.com');
    await dwell(prod.page, 2500);
    await shot(prod.page, 'ar-advantage-inbox');
    const accept = prod.page.locator('button:has-text("Accept")').first();
    if ((await accept.count()) > 0) {
      await click(prod.page, accept);
      await dwell(prod.page, 2000);
      await shot(prod.page, 'ar-advantage-accepted');
    }

    // Show the "A&R's Choice" badge on the public feed (seeded picks).
    await prod.page.goto(`${WEB}/feed`, { waitUntil: 'networkidle' });
    await dwell(prod.page, 2000);
    const badge = prod.page.locator('text=/A&R.?s Choice/i').first();
    if ((await badge.count()) > 0) {
      await badge.scrollIntoViewIfNeeded().catch(() => {});
      await dwell(prod.page, 1500);
      await shot(prod.page, 'ar-advantage-feed-badge');
    }
    await tour(prod.page, 3000);
    return finish(prod.ctx, prod.page, 'ar-advantage');
  });

  await browser.close();

  console.log('\n========== SUMMARY ==========');
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? `  -> ${r.video ?? '(no video)'}` : `  (${r.error})`}`);
  }
  console.log(`\nClips dir: ${OUT}\nStills dir: ${SHOTS}`);
  process.exit(0);
})();
