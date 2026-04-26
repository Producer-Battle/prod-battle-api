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
    expect((await getMatch(app, match.roomCode)).status).toBe('results');
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

  it('ranked gate: anonymous request returns 402', async () => {
    const anonApp = buildTestApp(); // no asUser -> anonymous
    const { status, json } = await postJson<{ error: string }>(anonApp, '/matches', {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(status).toBe(402);
    expect((json as { error: string }).error).toBe('ranked_requires_pro');
  });

  it('ranked gate: free authenticated producer returns 402', async () => {
    const freeUser = await seedTestUser(uniqueHandle('rk-free'), {
      plan: 'free',
      role: 'producer',
    });
    const freeApp = buildTestApp({ asUser: freeUser });
    const { status, json } = await postJson<{ error: string }>(freeApp, '/matches', {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(status).toBe(402);
    expect((json as { error: string }).error).toBe('ranked_requires_pro');
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
