import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createMatch,
  getMatch,
  getResults,
  getReveal,
  joinRoom,
  postJson,
  startRoom,
  submitTrack,
  uniqueHandle,
  voteForAll,
} from '../harness.js';
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

describe('mode: ranked', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('runs the full flow with 4 FFA-8 players and explicit genre', async () => {
    // Use a paid user to create the ranked match.
    const paidUser = await seedTestUser(uniqueHandle('rk-paid-host'), {
      plan: 'paid',
      role: 'producer',
    });
    const paidApp = buildTestApp({ asUser: paidUser });

    const match = await createMatch(paidApp, {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(match.mode).toBe('ranked');
    expect(match.teamSize).toBe(1);
    expect(match.teamCount).toBe(8);
    expect(match.genre.slug).toBe(TEST_GENRE_SLUG);

    const [host, ...rest] = Array.from({ length: 4 }, (_, i) => uniqueHandle(`rk-${i}`));
    if (!host) throw new Error('handles[] empty');
    const handles = [host, ...rest];
    for (const h of handles) await joinRoom(app, match.roomCode, h);
    await startRoom(app, match.roomCode, host);

    const ownSubmissionByHandle = new Map<string, string>();
    for (const h of handles) {
      ownSubmissionByHandle.set(h, await submitTrack(app, match.roomCode, h));
    }
    expect((await getMatch(app, match.roomCode)).currentPhase).toBe('vote');

    const items = await getReveal(app, match.roomCode);
    for (const h of handles) {
      await voteForAll(app, match.roomCode, h, ownSubmissionByHandle.get(h) ?? null, items);
    }

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(4);
    const final = await getMatch(app, match.roomCode);
    expect(final.status).toBe('results');
    // Same voteStats / voteOutcome assertions as the QP test - confirming
    // the ranked path produces the same results-shape.
    expect(final.voteStats.seated).toBe(4);
    expect(final.voteStats.voted).toBe(4);
    expect(final.voteStats.fullVoted).toBe(4);
    expect(final.voteOutcome).toBe('complete');
  });

  it('honor: 2 vote, 1 ghosts in ranked; ghost takes ranked-sized hit (-3)', async () => {
    // Same scenario as the QP regression test, but in ranked mode. The
    // ranked_no_vote fallback is -3 (vs -2 for QP). First-offence
    // forgiveness halves negative penalties, so the ghost should land
    // around -2 here. Voters should still get +1 regen.
    const paidUser = await seedTestUser(uniqueHandle('rk-paid-ghost'), {
      plan: 'paid',
      role: 'producer',
    });
    const paidApp = buildTestApp({ asUser: paidUser });
    const match = await createMatch(paidApp, { mode: 'ranked', genreSlug: TEST_GENRE_SLUG });

    const handles = ['alpha', 'beta', 'gamma'].map((p) => uniqueHandle(`rk-vote-${p}`));
    for (const h of handles) await joinRoom(app, match.roomCode, h);
    const host = handles[0];
    if (!host) throw new Error('handles empty');
    await startRoom(app, match.roomCode, host);

    const ownByHandle = new Map<string, string>();
    for (const h of handles) ownByHandle.set(h, await submitTrack(app, match.roomCode, h));

    const reveal = await getReveal(app, match.roomCode);
    const [voterA, voterB, ghost] = handles as [string, string, string];
    await voteForAll(app, match.roomCode, voterA, ownByHandle.get(voterA) ?? null, reveal);
    await voteForAll(app, match.roomCode, voterB, ownByHandle.get(voterB) ?? null, reveal);

    // Force the vote-phase timer to expire and run the outcome path.
    const { db } = await import('../../db/client.js');
    const { sql } = await import('drizzle-orm');
    const { applyMatchOutcome } = await import('../../honor/outcomes.js');
    await db().execute(
      sql`UPDATE matches SET status = 'results', vote_outcome = 'incomplete' WHERE id = ${match.id}`,
    );
    await applyMatchOutcome(match.id);

    const rows = (await db().execute<{ handle: string; honor_delta: number }>(
      sql`SELECT u.handle, mp.honor_delta
            FROM match_players mp
            JOIN users u ON u.id = mp.user_id
           WHERE mp.match_id = ${match.id}`,
    )) as Array<{ handle: string; honor_delta: number }>;
    const deltaByHandle = new Map(rows.map((r) => [r.handle, Number(r.honor_delta)]));

    expect(deltaByHandle.get(voterA)).toBeGreaterThan(0);
    expect(deltaByHandle.get(voterB)).toBeGreaterThan(0);
    expect(deltaByHandle.get(ghost)).toBeLessThan(0);
  });

  it('matchmaking picks an open ranked lobby over spawning a new one', async () => {
    const paidUser = await seedTestUser(uniqueHandle('rk-paid-reuse'), {
      plan: 'paid',
      role: 'producer',
    });
    const paidApp = buildTestApp({ asUser: paidUser });

    const first = await createMatch(paidApp, { mode: 'ranked', genreSlug: TEST_GENRE_SLUG });
    await joinRoom(app, first.roomCode, uniqueHandle('rk-reuse'));

    // Second creation also needs a paid user so it can create a lobby if needed.
    // In practice matchmaking finds the open lobby and returns it directly.
    const second = await createMatch(paidApp, { mode: 'ranked', genreSlug: TEST_GENRE_SLUG });
    expect(second.roomCode).toBe(first.roomCode);
  });

  // ─── Ranked creation gate tests ───────────────────────────────────────────

  it('ranked gate: anonymous request returns 401', async () => {
    const anonApp = buildTestApp(); // no asUser -> anonymous
    const { status, json } = await postJson<{ error: string }>(anonApp, '/matches', {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(status).toBe(401);
    expect((json as { error: string }).error).toBe('ranked_requires_signin');
  });

  it('ranked gate: free authenticated producer can create', async () => {
    const freeUser = await seedTestUser(uniqueHandle('rk-free'), {
      plan: 'free',
      role: 'producer',
    });
    const freeApp = buildTestApp({ asUser: freeUser });
    const match = await createMatch(freeApp, {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(match.mode).toBe('ranked');
  });

  it('ranked gate: paid producer returns 201', async () => {
    const paidUser = await seedTestUser(uniqueHandle('rk-paid-gate'), {
      plan: 'paid',
      role: 'producer',
    });
    const paidApp = buildTestApp({ asUser: paidUser });
    const match = await createMatch(paidApp, {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(match.mode).toBe('ranked');
  });

  it('ranked gate: admin returns 201', async () => {
    const adminUser = await seedTestUser(uniqueHandle('rk-admin'), {
      plan: 'free',
      role: 'admin',
    });
    const adminApp = buildTestApp({ asUser: adminUser });
    const match = await createMatch(adminApp, {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(match.mode).toBe('ranked');
  });
});
