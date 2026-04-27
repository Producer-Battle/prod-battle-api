# Browser E2E scripts

Playwright scripts that drive a real browser through the full UI to
exercise paths the API-level e2e suite can't reach: heartbeat / grace,
mid-match disconnects, anonymous reveal voting, sign-up + email verify,
ranked outcome end-to-end.

These complement (don't replace) `pnpm test:e2e`. The handler suite is
fast and runs in CI; these scripts are slow, need a full local stack,
and are run on demand when changing user-facing flows.

## Prerequisites

Local stack up:

```bash
cd ../../prod-battle-infra
docker compose up -d
```

Required services: `web` (5173), `api` (8080), `postgres` (5433),
`redis` (6380), `mailpit` (8025).

The Playwright runtime lives in `~/.claude/skills/playwright-skill` and
already has Chromium installed.

## Run

From the skill directory:

```bash
cd ~/.claude/skills/playwright-skill

# 4-player ranked match: signup → verify → ranked → submit → vote →
# results. Verifies calibration ticked, lp_delta written, rankings
# row touched.
node run.js ../../work/producer-battle/prod-battle-api/scripts/browser-e2e/ranked-flow.js

# Anti-grief: empty submission abandon + mid-match disconnect grace.
node run.js ../../work/producer-battle/prod-battle-api/scripts/browser-e2e/antigrief.js
```

Each run signs up fresh users (real mailpit verify) — the dev DB grows
each run. `pnpm db:reset` between runs if you care.

## Conventions

- Each scenario script is self-contained — helpers are inlined rather
  than extracted to a sibling lib because the playwright skill copies
  the script to its own working directory before exec, breaking
  relative `require('./lib.js')`. Duplication is ~80 lines per script;
  worth it for portability.
- Scripts exit 1 on any scenario failure.
- WAV file is written to `/tmp/pb-browser-e2e.wav` on every run.
- Direct DB / Redis access is used only for ground-truth checks and
  test-only state mutations (e.g. lowering `graceSeconds` for
  antigrief.js so we don't wait 2 minutes per grace scan).

## When to run

- After touching `src/honor/**`, `src/presence/**`, `src/tiers/**`,
  `src/realtime/tick.ts`, the WS layer in `src/ws/**`, or anything in
  `src/routes/phases.ts` / `matches.ts` that affects the lobby /
  submit / vote / results lifecycle.
- Before shipping changes to the auth / signup / email-verify path.
- After upgrading Playwright / Chromium in the skill.

## Limitations

- The grace-scan test cheats by `DEL`-ing the presence key directly
  in Redis. Existing TTLs are set using the cached `graceSeconds`
  value at WS-connect time, so lowering the rule via SQL doesn't
  shrink an already-set TTL. A pure end-to-end test would have to
  wait the full 120s grace + 30s tick scan window. Not worth it.
- No coverage yet for: honor gates blocking ranked queue (would need
  to drop a user below honor 50), DMCA tiered penalties, vote-ring
  detection. Documented limitation; add scenarios as those features
  become enforce-able from a browser path.
