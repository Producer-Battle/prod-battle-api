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

describe('mode: flip (Sample Flip)', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('creates an FFA-3 flip match with a flip source + generated pack, runs end-to-end', async () => {
    const match = await createMatch(app, {
      mode: 'flip',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 3,
    });
    expect(match.mode).toBe('flip');
    expect(match.teamCount).toBe(3);
    // Flip resolves a source (we seeded one tagged to phonk) and generates
    // a drum pack alongside it.
    expect(match.flipSource).not.toBeNull();
    expect(match.flipSource?.label).toBe('test-flip-loop');
    expect(match.samplePack).not.toBeNull();

    const [host, ...rest] = Array.from({ length: 3 }, (_, i) => uniqueHandle(`fp-${i}`));
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
    expect(items).toHaveLength(3);
    for (const h of handles) {
      await voteForAll(app, match.roomCode, h, ownSubmissionByHandle.get(h) ?? null, items);
    }

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.rank).sort()).toEqual([1, 2, 3]);
    expect((await getMatch(app, match.roomCode)).status).toBe('results');
  });

  it('round-trips the flip source payload via GET /matches/:code', async () => {
    const match = await createMatch(app, {
      mode: 'flip',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 3,
    });
    const fetched = await getMatch(app, match.roomCode);
    expect(fetched.flipSource?.id).toBe(match.flipSource?.id);
    expect(fetched.flipSource?.url).toBe(match.flipSource?.url);
  });
});
