// E2E tests for staleMatchSweep() - validates every sweep rule against a
// real Postgres database at the test port.
//
// Approach: insert fixture rows with backdated timestamps directly via raw
// SQL so the sweep's interval conditions are satisfied immediately.
// No HTTP layer needed - we call the exported function directly.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { staleMatchSweep } from '../../realtime/tick.js';
import { resetMatchState, seedTestFixtures } from '../seed.js';

// Defeat the 30-second throttle inside staleMatchSweep. The module-level
// `lastSweepAt` persists across tests in the same process, so each call must
// present a `Date.now()` that is at least 30_000ms greater than whatever the
// previous invocation set. We use a monotonically increasing epoch offset so
// each withFreshSweep call sees a unique, sufficiently-future timestamp.
let sweepEpoch = Date.now() + 120_000;
function withFreshSweep<T>(fn: () => Promise<T>): Promise<T> {
  sweepEpoch += 60_000;
  const epoch = sweepEpoch;
  // Narrow restore to just the Date.now spy. vi.restoreAllMocks() would also
  // undo the ioredis + S3 presigner mocks from src/tests/setup.ts, leaking
  // real services into later test files.
  const spy = vi.spyOn(Date, 'now').mockReturnValue(epoch);
  return fn().finally(() => spy.mockRestore());
}

describe('staleMatchSweep', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('rule 1: cancels empty lobby older than 10 minutes with no seated players', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'lobby', 1, 8, ${genreId}, now() - interval '15 minutes')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ status: string; ended_at: string | null }>(
      sql`SELECT status, ended_at FROM matches WHERE id = ${matchId}`,
    );
    const row = (rows as Array<{ status: string; ended_at: string | null }>)[0];
    expect(row?.status).toBe('cancelled');
    expect(row?.ended_at).not.toBeNull();
  });

  it('rule 1: does NOT cancel a lobby that has a seated player', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'lobby', 1, 8, ${genreId}, now() - interval '15 minutes')
    `);

    const userId = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, plan)
      VALUES (${userId}, ${`${userId}@test.local`}, ${userId.replace(/-/g, '').slice(0, 20)}, 'producer', 'free')
    `);
    await d.execute(sql`
      INSERT INTO match_players (match_id, user_id, is_spectator)
      VALUES (${matchId}, ${userId}, false)
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ status: string }>(
      sql`SELECT status FROM matches WHERE id = ${matchId}`,
    );
    const row = (rows as Array<{ status: string }>)[0];
    expect(row?.status).toBe('lobby');
  });

  it('rule 1: does NOT cancel a daily lobby', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, daily_date, created_at)
      VALUES
        (${matchId}, 'daily', 'lobby', 1, 8, ${genreId}, ${today}::date, now() - interval '15 minutes')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ status: string }>(
      sql`SELECT status FROM matches WHERE id = ${matchId}`,
    );
    const row = (rows as Array<{ status: string }>)[0];
    expect(row?.status).toBe('lobby');
  });

  it('rule 2: cancels a lobby older than 30 minutes with no battle_phase', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    const userId = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, plan)
      VALUES (${userId}, ${`${userId}@test.local`}, ${userId.replace(/-/g, '').slice(0, 20)}, 'producer', 'free')
    `);
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'lobby', 1, 8, ${genreId}, now() - interval '35 minutes')
    `);
    // Seated player so rule 1 does not fire (rule 1 fires at 10 min with NO players).
    await d.execute(sql`
      INSERT INTO match_players (match_id, user_id, is_spectator)
      VALUES (${matchId}, ${userId}, false)
    `);
    // No battle_phase row.

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ status: string; ended_at: string | null }>(
      sql`SELECT status, ended_at FROM matches WHERE id = ${matchId}`,
    );
    const row = (rows as Array<{ status: string; ended_at: string | null }>)[0];
    expect(row?.status).toBe('cancelled');
    expect(row?.ended_at).not.toBeNull();
  });

  it('rule 3: cancels a submit match where timer expired 5+ minutes ago with no submissions', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'submit', 1, 8, ${genreId}, now() - interval '1 hour')
    `);
    await d.execute(sql`
      INSERT INTO battle_phases (match_id, current_phase, transitions_at)
      VALUES (${matchId}, 'submit', now() - interval '10 minutes')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ status: string; ended_at: string | null }>(
      sql`SELECT status, ended_at FROM matches WHERE id = ${matchId}`,
    );
    const row = (rows as Array<{ status: string; ended_at: string | null }>)[0];
    expect(row?.status).toBe('cancelled');
    expect(row?.ended_at).not.toBeNull();
  });

  it('rule 3: does NOT cancel a submit match that has submissions', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    const userId = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, plan)
      VALUES (${userId}, ${`${userId}@test.local`}, ${userId.replace(/-/g, '').slice(0, 20)}, 'producer', 'free')
    `);
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'submit', 1, 8, ${genreId}, now() - interval '1 hour')
    `);
    await d.execute(sql`
      INSERT INTO battle_phases (match_id, current_phase, transitions_at)
      VALUES (${matchId}, 'submit', now() - interval '10 minutes')
    `);
    await d.execute(sql`
      INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url)
      VALUES (${randomUUID()}, ${matchId}, ${userId}, ${genreId}, 'http://localhost:9000/pb-test/audio/test.mp3')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ status: string }>(
      sql`SELECT status FROM matches WHERE id = ${matchId}`,
    );
    const row = (rows as Array<{ status: string }>)[0];
    expect(row?.status).toBe('submit');
  });

  it('rule 4: hard-deletes cancelled matches older than 7 days', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at, ended_at)
      VALUES
        (${matchId}, 'quickplay', 'cancelled', 1, 8, ${genreId},
         now() - interval '8 days', now() - interval '8 days')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(sql`SELECT id FROM matches WHERE id = ${matchId}`);
    expect(rows as Array<{ id: string }>).toHaveLength(0);
  });

  it('rule 4: does NOT delete a recently cancelled match (< 7 days)', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at, ended_at)
      VALUES
        (${matchId}, 'quickplay', 'cancelled', 1, 8, ${genreId},
         now() - interval '3 days', now() - interval '3 days')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(sql`SELECT id FROM matches WHERE id = ${matchId}`);
    expect(rows as Array<{ id: string }>).toHaveLength(1);
  });

  it('rule 5: deletes orphaned uploaded sample packs with zero samples older than 24 hours', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const packId = randomUUID();
    await d.execute(sql`
      INSERT INTO sample_packs
        (id, genre_id, kind, name, samples, created_at)
      VALUES
        (${packId}, ${genreId}, 'uploaded', 'orphan-pack', '[]'::jsonb, now() - interval '25 hours')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(
      sql`SELECT id FROM sample_packs WHERE id = ${packId}`,
    );
    expect(rows as Array<{ id: string }>).toHaveLength(0);
  });

  it('rule 5: does NOT delete an uploaded pack with samples even if old', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const packId = randomUUID();
    await d.execute(sql`
      INSERT INTO sample_packs
        (id, genre_id, kind, name, samples, created_at)
      VALUES
        (${packId}, ${genreId}, 'uploaded', 'non-empty-pack',
         '[{"stemType":"kick","name":"k","url":"http://x/k.wav"}]'::jsonb,
         now() - interval '25 hours')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(
      sql`SELECT id FROM sample_packs WHERE id = ${packId}`,
    );
    expect(rows as Array<{ id: string }>).toHaveLength(1);
  });

  it('rule 5: does NOT delete a fresh orphaned pack (< 24 hours)', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const packId = randomUUID();
    await d.execute(sql`
      INSERT INTO sample_packs
        (id, genre_id, kind, name, samples, created_at)
      VALUES
        (${packId}, ${genreId}, 'uploaded', 'fresh-orphan', '[]'::jsonb, now() - interval '1 hour')
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(
      sql`SELECT id FROM sample_packs WHERE id = ${packId}`,
    );
    expect(rows as Array<{ id: string }>).toHaveLength(1);
  });

  it('rule 6: deletes expired free-tier submissions (expires_at < now())', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    const userId = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, plan)
      VALUES (${userId}, ${`${userId}@test.local`}, ${userId.replace(/-/g, '').slice(0, 20)}, 'producer', 'free')
    `);
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'results', 1, 8, ${genreId}, now() - interval '31 days')
    `);

    const subId = randomUUID();
    await d.execute(sql`
      INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, expires_at)
      VALUES (
        ${subId},
        ${matchId},
        ${userId},
        ${genreId},
        'http://localhost:9000/pb-test/audio/expired.mp3',
        now() - interval '1 day'
      )
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(
      sql`SELECT id FROM submissions WHERE id = ${subId}`,
    );
    expect(rows as Array<{ id: string }>).toHaveLength(0);
  });

  it('rule 6: does NOT delete a free-tier submission that has not yet expired', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    const userId = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, plan)
      VALUES (${userId}, ${`${userId}@test.local`}, ${userId.replace(/-/g, '').slice(0, 20)}, 'producer', 'free')
    `);
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'results', 1, 8, ${genreId}, now() - interval '10 days')
    `);

    const subId = randomUUID();
    await d.execute(sql`
      INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, expires_at)
      VALUES (
        ${subId},
        ${matchId},
        ${userId},
        ${genreId},
        'http://localhost:9000/pb-test/audio/fresh.mp3',
        now() + interval '20 days'
      )
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(
      sql`SELECT id FROM submissions WHERE id = ${subId}`,
    );
    expect(rows as Array<{ id: string }>).toHaveLength(1);
  });

  it('rule 6: does NOT delete a paid-tier submission (expires_at IS NULL)', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    const matchId = randomUUID();
    const userId = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, plan)
      VALUES (${userId}, ${`${userId}@test.local`}, ${userId.replace(/-/g, '').slice(0, 20)}, 'producer', 'paid')
    `);
    await d.execute(sql`
      INSERT INTO matches
        (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES
        (${matchId}, 'quickplay', 'results', 1, 8, ${genreId}, now() - interval '60 days')
    `);

    const subId = randomUUID();
    await d.execute(sql`
      INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, expires_at)
      VALUES (
        ${subId},
        ${matchId},
        ${userId},
        ${genreId},
        'http://localhost:9000/pb-test/audio/paid.mp3',
        NULL
      )
    `);

    await withFreshSweep(() => staleMatchSweep());

    const rows = await d.execute<{ id: string }>(
      sql`SELECT id FROM submissions WHERE id = ${subId}`,
    );
    expect(rows as Array<{ id: string }>).toHaveLength(1);
  });

  // ─── Rule 8: stale guest cleanup ──────────────────────────────────────

  async function seedGuest(opts: { ageDays: number; handle?: string }): Promise<string> {
    const d = db();
    const handle = opts.handle ?? `sweep-guest-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, created_at)
      VALUES (${id}, ${handle} || '@guest.local', ${handle}, 'producer',
              now() - make_interval(days => ${opts.ageDays}))
    `);
    return id;
  }

  async function userExists(id: string): Promise<boolean> {
    const d = db();
    const rows = await d.execute<{ id: string }>(sql`SELECT id FROM users WHERE id = ${id}`);
    return (rows as Array<{ id: string }>).length > 0;
  }

  it('rule 8a: deletes zero-trace guests older than 30 days, keeps fresh ones', async () => {
    const stale = await seedGuest({ ageDays: 45 });
    const fresh = await seedGuest({ ageDays: 5 });

    await withFreshSweep(() => staleMatchSweep());

    expect(await userExists(stale)).toBe(false);
    expect(await userExists(fresh)).toBe(true);
  });

  it('rule 8: keeps guests with submissions regardless of age', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const guest = await seedGuest({ ageDays: 200 });

    const matchId = randomUUID();
    await d.execute(sql`
      INSERT INTO matches (id, mode, status, team_size, team_count, primary_genre_id, created_at)
      VALUES (${matchId}, 'quickplay', 'results', 1, 8, ${genreId}, now() - interval '200 days')
    `);
    await d.execute(sql`
      INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, duration_sec)
      VALUES (${randomUUID()}, ${matchId}, ${guest}, ${genreId},
              'http://localhost:9000/pb-test/audio/keep.mp3', 30)
    `);

    await withFreshSweep(() => staleMatchSweep());

    expect(await userExists(guest)).toBe(true);
  });

  it('rule 8b: deletes lobby-only guests dormant >90 days, keeps recently seated', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();

    async function seatGuestInMatch(userId: string, matchAgeDays: number): Promise<void> {
      const matchId = randomUUID();
      const teamId = randomUUID();
      // status 'results', not 'cancelled': rule 4 garbage-collects old
      // cancelled matches earlier in the same sweep, which would cascade
      // the seats away before rule 8 looks at them.
      await d.execute(sql`
        INSERT INTO matches (id, mode, status, team_size, team_count, primary_genre_id, created_at)
        VALUES (${matchId}, 'quickplay', 'results', 1, 8, ${genreId},
                now() - make_interval(days => ${matchAgeDays}))
      `);
      await d.execute(sql`
        INSERT INTO match_teams (id, match_id, seat) VALUES (${teamId}, ${matchId}, 0)
      `);
      await d.execute(sql`
        INSERT INTO match_players (match_id, user_id, team_id)
        VALUES (${matchId}, ${userId}, ${teamId})
      `);
    }

    const dormant = await seedGuest({ ageDays: 120 });
    await seatGuestInMatch(dormant, 100);

    const active = await seedGuest({ ageDays: 120 });
    await seatGuestInMatch(active, 100);
    await seatGuestInMatch(active, 10); // re-seated recently -> kept

    await withFreshSweep(() => staleMatchSweep());

    expect(await userExists(dormant)).toBe(false);
    expect(await userExists(active)).toBe(true);
  });

  it('rule 8: never touches registered accounts, however old and idle', async () => {
    const d = db();
    const id = randomUUID();
    await d.execute(sql`
      INSERT INTO users (id, email, handle, role, created_at)
      VALUES (${id}, 'sweep-real-' || ${id} || '@test.local',
              'sweep-real-' || substr(${id}, 1, 8), 'producer',
              now() - interval '400 days')
    `);

    await withFreshSweep(() => staleMatchSweep());

    expect(await userExists(id)).toBe(true);
  });
});
