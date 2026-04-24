import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures } from '../seed.js';
import {
  buildTestApp,
  createMatch,
  getMatch,
  getReveal,
  joinRoom,
  postJson,
  startRoom,
  submitTrack,
  uniqueHandle,
} from '../harness.js';

describe('mode: practice', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('runs a solo practice match: lobby -> submit -> vote, single entry recorded', async () => {
    const match = await createMatch(app, {
      mode: 'practice',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 1,
    });
    expect(match.mode).toBe('practice');
    expect(match.teamCount).toBe(1);
    // practice uses DEFAULT_SAMPLE_MODE='none' -> no generated pack.
    expect(match.samplePack).toBeNull();

    const solo = uniqueHandle('pr-solo');
    await joinRoom(app, match.roomCode, solo);
    await startRoom(app, match.roomCode, solo);

    const ownSubmission = await submitTrack(app, match.roomCode, solo);
    expect(ownSubmission).toMatch(/^[0-9a-f-]{36}$/);

    // Solo: one seated, one submitted -> short-circuits into vote phase.
    // There's nobody else to vote on, so the match sits here until the
    // tick loop ages it out. We assert the intermediate state and stop.
    const after = await getMatch(app, match.roomCode);
    expect(after.currentPhase).toBe('vote');

    const items = await getReveal(app, match.roomCode);
    expect(items).toHaveLength(1);

    // Self-vote must still be rejected in practice mode.
    const selfVote = await postJson(app, `/rooms/${match.roomCode}/vote`, {
      user: solo,
      votes: [{ submissionId: items[0]!.submissionId, score: 5 }],
    });
    expect(selfVote.status).toBe(403);
  });

  it('rejects practice creation with teamCount != 1', async () => {
    const { status } = await postJson(app, '/matches', {
      mode: 'practice',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 2,
    });
    expect(status).toBe(400);
  });
});
