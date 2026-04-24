import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures } from '../seed.js';

describe('mode: tournament', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('runs a 1v1 tournament match end-to-end', async () => {
    const match = await createMatch(app, {
      mode: 'tournament',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 2,
    });
    expect(match.mode).toBe('tournament');
    expect(match.teamCount).toBe(2);

    const a = uniqueHandle('tn-a');
    const b = uniqueHandle('tn-b');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(app, match.roomCode, a);

    const subA = await submitTrack(app, match.roomCode, a);
    const subB = await submitTrack(app, match.roomCode, b);
    expect((await getMatch(app, match.roomCode)).currentPhase).toBe('vote');

    const items = await getReveal(app, match.roomCode);
    await voteForAll(app, match.roomCode, a, subA, items);
    await voteForAll(app, match.roomCode, b, subB, items);

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.rank).sort()).toEqual([1, 2]);
    expect((await getMatch(app, match.roomCode)).status).toBe('results');
  });
});
