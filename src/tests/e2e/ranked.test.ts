import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures } from '../seed.js';
import {
  buildTestApp,
  createMatch,
  getMatch,
  getResults,
  getReveal,
  joinRoom,
  startRoom,
  submitTrack,
  uniqueHandle,
  voteForAll,
} from '../harness.js';

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
    const match = await createMatch(app, {
      mode: 'ranked',
      genreSlug: TEST_GENRE_SLUG,
    });
    expect(match.mode).toBe('ranked');
    expect(match.teamSize).toBe(1);
    expect(match.teamCount).toBe(8);
    expect(match.genre.slug).toBe(TEST_GENRE_SLUG);

    const handles = Array.from({ length: 4 }, (_, i) => uniqueHandle(`rk-${i}`));
    for (const h of handles) await joinRoom(app, match.roomCode, h);
    await startRoom(app, match.roomCode, handles[0]!);

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
    const first = await createMatch(app, { mode: 'ranked', genreSlug: TEST_GENRE_SLUG });
    await joinRoom(app, first.roomCode, uniqueHandle('rk-reuse'));
    const second = await createMatch(app, { mode: 'ranked', genreSlug: TEST_GENRE_SLUG });
    expect(second.roomCode).toBe(first.roomCode);
  });
});
