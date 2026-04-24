import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRIVATE_SUBMIT_SECONDS_PRESETS } from '../../matchmaking/defaults.js';
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
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures } from '../seed.js';

describe('mode: private', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('runs a 1v1 with host-picked submit preset and no min-player gate', async () => {
    const preset = PRIVATE_SUBMIT_SECONDS_PRESETS[0]; // 300s - the shortest allowed
    const match = await createMatch(app, {
      mode: 'private',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 2,
      submitSeconds: preset,
    });
    expect(match.mode).toBe('private');
    expect(match.teamCount).toBe(2);
    expect(match.submitSeconds).toBe(preset);

    const a = uniqueHandle('pv-a');
    const b = uniqueHandle('pv-b');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);

    // No min-player gate for private - 2 seated is enough.
    await startRoom(app, match.roomCode, a);

    const subA = await submitTrack(app, match.roomCode, a);
    const subB = await submitTrack(app, match.roomCode, b);
    expect((await getMatch(app, match.roomCode)).currentPhase).toBe('vote');

    const items = await getReveal(app, match.roomCode);
    expect(items).toHaveLength(2);
    await voteForAll(app, match.roomCode, a, subA, items);
    await voteForAll(app, match.roomCode, b, subB, items);

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.rank).sort()).toEqual([1, 2]);
  });

  it('rejects submitSeconds outside the preset list', async () => {
    const { status, json } = await postJson(app, '/matches', {
      mode: 'private',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 2,
      submitSeconds: 437, // not in PRIVATE_SUBMIT_SECONDS_PRESETS
    });
    expect(status).toBe(400);
    expect(json).toMatchObject({});
  });

  it('rejects private creation when genreSlug is omitted', async () => {
    const { status } = await postJson(app, '/matches', {
      mode: 'private',
      teamSize: 1,
      teamCount: 2,
      submitSeconds: PRIVATE_SUBMIT_SECONDS_PRESETS[0],
    });
    expect(status).toBe(400);
  });
});
