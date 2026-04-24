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

describe('mode: quickplay', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('runs the full lobby -> submit -> vote -> results flow with 4 players', async () => {
    // Quick Play = FFA-8, auto-picks a random system genre. Seeding only
    // "phonk" guarantees that's what gets picked.
    const match = await createMatch(app, { mode: 'quickplay' });
    expect(match.mode).toBe('quickplay');
    expect(match.status).toBe('lobby');
    expect(match.teamSize).toBe(1);
    expect(match.teamCount).toBe(8);
    expect(match.samplePack).not.toBeNull();
    expect(match.genre.slug).toBe(TEST_GENRE_SLUG);

    // 4 players - quickplay's min-players gate.
    const [host, ...rest] = Array.from({ length: 4 }, (_, i) => uniqueHandle(`qp-${i}`));
    if (!host) throw new Error('handles[] empty');
    const handles = [host, ...rest];
    for (const h of handles) await joinRoom(app, match.roomCode, h);

    // Any seated player may start (no explicit host until auth lands).
    await startRoom(app, match.roomCode, host);

    const afterStart = await getMatch(app, match.roomCode);
    expect(afterStart.currentPhase).toBe('submit');

    // Each player submits. The last submission triggers
    // maybeAdvanceAfterSubmission, which advances the match to 'vote'.
    const ownSubmissionByHandle = new Map<string, string>();
    for (const h of handles) {
      ownSubmissionByHandle.set(h, await submitTrack(app, match.roomCode, h));
    }

    const afterSubmit = await getMatch(app, match.roomCode);
    expect(afterSubmit.currentPhase).toBe('vote');

    const items = await getReveal(app, match.roomCode);
    expect(items).toHaveLength(4);

    // Everyone votes on the 3 other submissions. The final voter closes
    // the vote window via maybeAdvanceAfterVote -> results.
    for (const h of handles) {
      await voteForAll(app, match.roomCode, h, ownSubmissionByHandle.get(h) ?? null, items);
    }

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.rank).sort()).toEqual([1, 2, 3, 4]);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }

    const final = await getMatch(app, match.roomCode);
    expect(final.status).toBe('results');
  });

  it('rejects /start with waiting_for_players when fewer than 4 are seated', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const host = uniqueHandle('qp-lonely');
    await joinRoom(app, match.roomCode, host);

    const res = await app.request(`/rooms/${match.roomCode}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: host }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; seated: number; minPlayers: number };
    expect(body.error).toBe('waiting_for_players');
    expect(body.minPlayers).toBe(4);
    expect(body.seated).toBe(1);
  });

  it('reuses an open lobby instead of creating a duplicate', async () => {
    const first = await createMatch(app, { mode: 'quickplay' });
    await joinRoom(app, first.roomCode, uniqueHandle('qp-reuse'));

    const second = await createMatch(app, { mode: 'quickplay' });
    expect(second.roomCode).toBe(first.roomCode);
  });
});
