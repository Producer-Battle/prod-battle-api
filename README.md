# prod-battle-api

Backend for the Producer Battle platform. Hono on Node 22, Postgres +
Redis + Scaleway Object Storage. Serves HTTP (REST, documented via
OpenAPI) and WebSockets from the same process.

## Stack

- **Hono 4** + `@hono/zod-openapi` - code-first OpenAPI from Zod schemas
- **Node 22** - plain CommonJS/ESM, no Bun (for CI simplicity)
- **drizzle-orm** + `drizzle-kit` on Postgres 16
- **ioredis** - pub/sub, hot match state, tick-worker leader election
- **better-auth** - sessions in Postgres
- **Scaleway Object Storage** via AWS SDK v3 (S3-compatible)
- **Scaleway Serverless Jobs** - ffmpeg transcoder (defined in `jobs/ffmpeg/`)

## Layout

```
src/
  server.ts           HTTP + WS entry
  env.ts              zod-validated env vars
  openapi.ts          OpenAPI app factory (used by emit script)
  routes/             Hono route groups (health wired; rest are stubs)
  ws/                 WebSocket upgrade + per-match session
  realtime/           Redis pub/sub, tick worker, leader election
  room/               match state machine (LOBBY→SUBMIT→REVEAL→VOTE→RESULTS)
  matchmaking/        Quick Play + Ranked queue
  genres/             system genre seed + registry helpers
  ranking/            Glicko-2
  audio/              presigned S3 uploads, transcode job dispatch
  db/
    schema.ts         drizzle schema - single source of truth for Postgres
    client.ts         drizzle client factory
    migrations/       drizzle-kit generated SQL

jobs/ffmpeg/          Scaleway Serverless Job: normalize + waveform JSON
scripts/              openapi emit + publish
.github/workflows/    ci.yml (lint/type/test/emit) + deploy.yml (docker → Scaleway Container Registry)
```

## Data model highlights

- **Matches support 1v1, 2v2, 3v3, 4v4, FFA** - stored as `team_size` × `team_count` with a check constraint `team_size * team_count <= 8`.
- **Genres have two tiers**: `system` (admin-curated, has `format_config`) and `user` (UGC tags). Ranked/quickplay requires `system`; private rooms + submission tags can use either.
- **Private rooms** set `primary_genre_id` plus optional `allowed_genre_ids[]` for rotation.
- **Submissions persist** - every match track lives on the producer's profile + genre leaderboard.
- **A&R role** with admin-verified applications (`ar_applications`) and watchlists.

See `src/db/schema.ts` for the full picture.

## Run locally

Prereqs: Node 22, pnpm 9, Postgres 16, Redis 7.

```sh
cp .env.example .env
# edit DATABASE_URL and REDIS_URL
pnpm install
pnpm db:push            # apply schema (dev-only; use db:generate+db:migrate for real)
pnpm dev
curl http://localhost:8080/health
```

## Emit OpenAPI spec

```sh
pnpm openapi:emit       # writes openapi.json
```

Published as `@producer-battle/prod-battle-api` to GitHub Packages on every
push to main; `prod-battle-web` pins a version and regenerates its TypeScript
client via `@hey-api/openapi-ts`.

## Deploy

On push to `main`: GitHub Actions builds the Docker image, pushes to the
Scaleway Container Registry (namespace from `prod-battle-infra`), and
updates the Serverless Container to pull the new image tag.

On release tag: same, but targets prod.

Secrets needed:

| Secret | Purpose |
|---|---|
| `SCW_REGISTRY_USER` / `SCW_REGISTRY_PASSWORD` | Scaleway registry push |
| `SCW_ACCESS_KEY` / `SCW_SECRET_KEY` | Scaleway API (container update) |
| `SCW_PROJECT_ID_STAGING` / `SCW_PROJECT_ID_PROD` | Project targeting |

## Honor system

Every signed-up user has an honor score from **0 to 100** (start: 100). It
gates competitive features (tournament 70+, ranked 50+, private hosting
30+, read-only below 10) and gently discourages disengagement. Values are
configurable via `/admin → Rules → honor`; the JSON lives in the
`game_rules` table and is read live by `applyMatchOutcome`.

| Mode | Lobby leave | Mid abandon | Empty (no submit) | No-vote (submitted, voted 0×) | Clean finish |
|---|---|---|---|---|---|
| Quickplay | -1 | -2 | -3 | -2 | +1 (+5 burst /10 clean) |
| Ranked | -2 | -5 | -3 | -3 | +1 (+5 burst /10 clean) |
| Private | -1 | -2 | -2 | -1 | +1 |
| Flip | -1 | -2 | -3 | -2 | +1 |
| Daily | -1 | -2 | -3 | -1 | +1 |
| Tournament | -2 | -7 | -5 | -3 | +1 |

Plus: DMCA tiers -5 / -15 / -25, vote-ring -50.

**First-offence forgiveness** halves any negative penalty if the player has
no other honor change in the rolling 30-day window. So a single slip costs
half. Repeated abandons hit at full value.

**Burst regen** (Quickplay + Ranked): every 10 consecutive clean matches in
the same mode adds an extra +5 on top of the per-match +1. Rehab lane for
players who fell below a gate.

**"Fully voted" threshold**:
- Live battles (qp/ranked/private/flip/tournament): voted on every other
  entry (`N - 1` if you submitted, else `N`).
- Daily Challenge: at least one vote counts. Daily plays each track as a
  60s preview, so 20 entries × 60s = ~20 minutes of attention; we don't
  ask for completionism on top of that.

**Daily-specific submission rules**: 90 second minimum, 240 second (4 min)
maximum. Battle modes don't enforce a length minimum because their timer
already does.

## Next steps

1. Wire up `better-auth` in `routes/auth.ts`.
2. Implement `routes/matches.ts` CRUD (create private room, join by code, start match).
3. Implement the WS handler + Redis pub/sub so two browsers can join a match room.
4. Run a real match end-to-end against local Postgres + Redis.
