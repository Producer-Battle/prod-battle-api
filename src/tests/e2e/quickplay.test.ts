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

    // 4 players - exercises the full multi-player flow (gate is min 2).
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
    // Regression: voteStats should reflect actual voting activity.
    // 4 seated; each voter cast 3 votes (everyone except self); threshold
    // for fullVoted is N-1 = 3. So all four are fully-voted AND voted.
    // Bug we fixed: a 3-player room where 2 voted on each other showed
    // 0/3 because the pill was using the strict fullVoted count.
    expect(final.voteStats.seated).toBe(4);
    expect(final.voteStats.voted).toBe(4);
    expect(final.voteStats.fullVoted).toBe(4);
    expect(final.voteOutcome).toBe('complete');
  });

  it('honor: 2 vote, 1 ghosts; ghost takes a small honor hit, 2 voters keep theirs', async () => {
    // Reproducing the user-reported flow: 3-player room, everyone submits,
    // two vote on every other entry, the third never votes. The two who
    // did the right thing must NOT be docked. Only the ghost-voter loses
    // honor.
    const match = await createMatch(app, { mode: 'quickplay' });
    const handles = ['alpha', 'beta', 'gamma'].map((p) => uniqueHandle(`vote-${p}`));
    for (const h of handles) await joinRoom(app, match.roomCode, h);
    const host = handles[0];
    if (!host) throw new Error('handles empty');
    await startRoom(app, match.roomCode, host);

    const ownByHandle = new Map<string, string>();
    for (const h of handles) ownByHandle.set(h, await submitTrack(app, match.roomCode, h));

    const reveal = await getReveal(app, match.roomCode);
    // Two voters do the full slate. The third never calls /vote.
    const [voterA, voterB, ghost] = handles as [string, string, string];
    await voteForAll(app, match.roomCode, voterA, ownByHandle.get(voterA) ?? null, reveal);
    await voteForAll(app, match.roomCode, voterB, ownByHandle.get(voterB) ?? null, reveal);

    // maybeAdvanceAfterVote will not fire (3rd voter is missing). Force the
    // tick path manually: jump the vote-phase timer to "now-1s" and let
    // tick.ts move the match to results. Direct DB manipulation is fine
    // in tests.
    const { db } = await import('../../db/client.js');
    const { sql } = await import('drizzle-orm');
    await db().execute(
      sql`UPDATE battle_phases SET transitions_at = now() - interval '1 second' WHERE match_id = ${match.id}`,
    );
    // Drive one tick by importing the inner advancePhase via the module.
    // Simpler: call applyMatchOutcome directly to exercise the honor path
    // we want to verify. This skips the phase_change pubsub but gets the
    // matchPlayers honor_delta written, which is what the test asserts.
    const { applyMatchOutcome } = await import('../../honor/outcomes.js');
    await db().execute(
      sql`UPDATE matches SET status = 'results', vote_outcome = 'incomplete' WHERE id = ${match.id}`,
    );
    await applyMatchOutcome(match.id);

    // Pull honor deltas. Voters who completed should be at +1; ghost
    // should be negative (the no_vote penalty, halved by first-offence).
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

  it('rejects /start with waiting_for_players when fewer than 2 are seated', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const host = uniqueHandle('qp-lonely');
    await joinRoom(app, match.roomCode, host);

    // postJson rides the app's cookie jar so the caller resolves as the
    // host they just joined as (raw app.request would arrive with a fresh
    // pb_anon cookie and get 403 identity-not-yours before the player-count
    // check even runs).
    const { status, json } = await postJson<{
      error: string;
      seated: number;
      minPlayers: number;
    }>(app, `/rooms/${match.roomCode}/start`, { user: host });
    expect(status).toBe(400);
    const body = json;
    expect(body.error).toBe('waiting_for_players');
    expect(body.minPlayers).toBe(2);
    expect(body.seated).toBe(1);
  });

  it('reuses an open lobby instead of creating a duplicate', async () => {
    const first = await createMatch(app, { mode: 'quickplay' });
    await joinRoom(app, first.roomCode, uniqueHandle('qp-reuse'));

    const second = await createMatch(app, { mode: 'quickplay' });
    expect(second.roomCode).toBe(first.roomCode);
  });
});
