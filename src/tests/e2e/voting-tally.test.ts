// Reproduces and characterises bugs around the vote tally for partial-
// submission scenarios:
//
//   "2 producers, 1 doesn't upload but still votes 5 ... since he is too
//    late ... and the other producer gets a score of 0.0?"
//
// Expected: B (who never submitted) votes 5 for A. A wins with a non-zero
// score. Anything else is a bug. We exercise quickplay, flip, ranked, and
// daily because the user reported the issue across modes ("ranked is broken
// too").
//
// The harness's `voteForAll` helper sends scores client-side; here we
// hand-build the vote payload so we can assert on the raw server tally and
// can specifically include / exclude self-votes.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { advancePhase } from '../../room/transitions.js';
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
} from '../harness.js';
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

// Force a match from `submit` (or `upload`) to `vote` even when not everyone
// has submitted - mirrors what the tick worker does when the timer expires.
async function forceVotePhase(matchId: string): Promise<void> {
  // The phase machine is lobby -> submit -> upload -> vote -> results. If
  // we're still in submit, hop through upload too. (Keeps the test agnostic
  // to whether the upload phase has been wired in for this match.)
  for (const from of ['submit', 'upload'] as const) {
    const ok = await advancePhase(matchId, from, 'vote', 90);
    if (ok) return;
  }
}

async function forceResultsPhase(matchId: string): Promise<void> {
  await advancePhase(matchId, 'vote', 'results', 0);
}

async function honorOf(handle: string): Promise<number> {
  const d = db();
  const [row] = (await d.execute<{ honor: number }>(
    sql`SELECT honor FROM users WHERE handle = ${handle} LIMIT 1`,
  )) as Array<{ honor: number }>;
  return Number(row?.honor ?? 0);
}

describe('voting tally', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  // ─── quickplay ─────────────────────────────────────────────────────────

  it('quickplay: only A submits, B votes 5 for A → A wins with score > 0', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const a = uniqueHandle('tally-a');
    const b = uniqueHandle('tally-b');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(app, match.roomCode, a);

    const aSubId = await submitTrack(app, match.roomCode, a);
    await forceVotePhase(match.id);
    expect((await getMatch(app, match.roomCode)).currentPhase).toBe('vote');

    const reveal = await getReveal(app, match.roomCode);
    expect(reveal).toHaveLength(1);
    expect(reveal[0]?.submissionId).toBe(aSubId);

    const voteRes = await postJson(app, `/rooms/${match.roomCode}/vote`, {
      user: b,
      votes: [{ submissionId: aSubId, score: 5 }],
    });
    expect(voteRes.status).toBe(200);
    expect((voteRes.json as { accepted: number }).accepted).toBe(1);

    await forceResultsPhase(match.id);

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(1);
    expect(results[0]?.handle).toBe(a);
    expect(results[0]?.rank).toBe(1);
    // Default seeded users get honor=100 → multiplier 1.5 → 5 * 1.5 = 7.5.
    expect(results[0]?.score).toBeCloseTo(7.5, 3);
  });

  it('quickplay: 2 producers both submit, both cross-vote 5 → both have score > 0', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const a = uniqueHandle('tally-bothA');
    const b = uniqueHandle('tally-bothB');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(app, match.roomCode, a);

    const aSubId = await submitTrack(app, match.roomCode, a);
    const bSubId = await submitTrack(app, match.roomCode, b);
    expect((await getMatch(app, match.roomCode)).currentPhase).toBe('vote');

    // Each casts: 5 for the other AND 3 for self. Server must drop the
    // self-vote silently and keep the cross-vote.
    for (const [voter, ownId, otherId] of [
      [a, aSubId, bSubId],
      [b, bSubId, aSubId],
    ] as const) {
      const res = await postJson(app, `/rooms/${match.roomCode}/vote`, {
        user: voter,
        votes: [
          { submissionId: otherId, score: 5 },
          { submissionId: ownId, score: 3 },
        ],
      });
      expect(res.status).toBe(200);
      // accepted excludes the self-drop, so should be 1.
      expect((res.json as { accepted: number }).accepted).toBe(1);
    }

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.score).toBeCloseTo(7.5, 3);
    }
  });

  it('quickplay: 3P, only A submits, B+C vote 5 → score = 2 * 5 * honorMul', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const a = uniqueHandle('tally-3a');
    const b = uniqueHandle('tally-3b');
    const c = uniqueHandle('tally-3c');
    for (const h of [a, b, c]) await joinRoom(app, match.roomCode, h);
    await startRoom(app, match.roomCode, a);

    const aSubId = await submitTrack(app, match.roomCode, a);
    await forceVotePhase(match.id);

    for (const voter of [b, c]) {
      const res = await postJson(app, `/rooms/${match.roomCode}/vote`, {
        user: voter,
        votes: [{ submissionId: aSubId, score: 5 }],
      });
      expect(res.status).toBe(200);
      expect((res.json as { accepted: number }).accepted).toBe(1);
    }

    await forceResultsPhase(match.id);

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(1);
    // Two voters, each at honor 100 (mul 1.5), each scoring 5 → 15 total.
    expect(results[0]?.score).toBeCloseTo(15, 3);
  });

  // ─── sample flip ───────────────────────────────────────────────────────

  it('flip: only A submits, B votes 5 for A → A wins with score > 0', async () => {
    const match = await createMatch(app, {
      mode: 'flip',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 2,
    });
    const a = uniqueHandle('flip-tally-a');
    const b = uniqueHandle('flip-tally-b');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(app, match.roomCode, a);

    const aSubId = await submitTrack(app, match.roomCode, a);
    await forceVotePhase(match.id);

    const reveal = await getReveal(app, match.roomCode);
    expect(reveal).toHaveLength(1);

    const voteRes = await postJson(app, `/rooms/${match.roomCode}/vote`, {
      user: b,
      votes: [{ submissionId: aSubId, score: 5 }],
    });
    expect(voteRes.status).toBe(200);
    expect((voteRes.json as { accepted: number }).accepted).toBe(1);

    await forceResultsPhase(match.id);

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.rank).toBe(1);
  });

  // ─── ranked (requires paid auth) ───────────────────────────────────────

  it('ranked: only A submits, B votes 5 for A → A wins with score > 0', async () => {
    const paidUser = await seedTestUser(uniqueHandle('rk-vt-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const paidApp = buildTestApp({ asUser: paidUser });

    const match = await createMatch(paidApp, { mode: 'ranked', genreSlug: TEST_GENRE_SLUG });
    const a = paidUser.handle;
    const b = uniqueHandle('rk-vt-b');
    await joinRoom(paidApp, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(paidApp, match.roomCode, a);

    const aSubId = await submitTrack(paidApp, match.roomCode, a);
    await forceVotePhase(match.id);

    const voteRes = await postJson(app, `/rooms/${match.roomCode}/vote`, {
      user: b,
      votes: [{ submissionId: aSubId, score: 5 }],
    });
    expect(voteRes.status).toBe(200);
    expect((voteRes.json as { accepted: number }).accepted).toBe(1);

    await forceResultsPhase(match.id);

    const results = await getResults(app, match.roomCode);
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.rank).toBe(1);
  });

  // ─── self-vote silent drop ────────────────────────────────────────────

  it('self-vote is silently dropped; only the cross-vote ends up in the votes table', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const a = uniqueHandle('self-a');
    const b = uniqueHandle('self-b');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(app, match.roomCode, a);

    const aSubId = await submitTrack(app, match.roomCode, a);
    const bSubId = await submitTrack(app, match.roomCode, b);

    const voteRes = await postJson(app, `/rooms/${match.roomCode}/vote`, {
      user: a,
      votes: [
        { submissionId: bSubId, score: 5 },
        { submissionId: aSubId, score: 3 },
      ],
    });
    expect(voteRes.status).toBe(200);
    expect((voteRes.json as { accepted: number }).accepted).toBe(1);

    const rows = (await db().execute<{ submission_id: string; weight: string }>(
      sql`SELECT submission_id, weight FROM votes WHERE match_id = ${match.id}`,
    )) as Array<{ submission_id: string; weight: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.submission_id).toBe(bSubId);
  });

  // ─── honor zero floor (current documented behaviour) ───────────────────

  it('honor < 30 silently weights vote to 0 (current curve, documented)', async () => {
    // Reproduces the trap that makes scores look "totally off" - a voter
    // with honor below the curve floor still gets a 200 from /vote (their
    // call "succeeds") but the row inserted has weight=0 and contributes
    // nothing to the tally. Asserts current behaviour so future curve
    // changes are explicit.
    const match = await createMatch(app, { mode: 'quickplay' });
    const a = uniqueHandle('low-a');
    const b = uniqueHandle('low-b');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(app, match.roomCode, a);

    const aSubId = await submitTrack(app, match.roomCode, a);
    await submitTrack(app, match.roomCode, b);

    // Crank B's honor below the curve floor (default: honor < 30 → 0).
    await db().execute(sql`UPDATE ${users} SET honor = 10 WHERE handle = ${b}`);
    expect(await honorOf(b)).toBe(10);

    const voteRes = await postJson(app, `/rooms/${match.roomCode}/vote`, {
      user: b,
      votes: [{ submissionId: aSubId, score: 5 }],
    });
    expect(voteRes.status).toBe(200);
    expect((voteRes.json as { accepted: number }).accepted).toBe(1);

    const rows = (await db().execute<{ weight: string }>(
      sql`SELECT weight FROM votes WHERE match_id = ${match.id} AND submission_id = ${aSubId}`,
    )) as Array<{ weight: string }>;
    expect(rows).toHaveLength(1);
    // current curve floor → weight 0 stored.
    expect(Number(rows[0]?.weight)).toBe(0);
  });

  // ─── late vote ─────────────────────────────────────────────────────────

  it('late vote (after results phase opens) is rejected with 400, not silently dropped', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const a = uniqueHandle('late-a');
    const b = uniqueHandle('late-b');
    await joinRoom(app, match.roomCode, a);
    await joinRoom(app, match.roomCode, b);
    await startRoom(app, match.roomCode, a);

    const aSubId = await submitTrack(app, match.roomCode, a);
    await forceVotePhase(match.id);
    await forceResultsPhase(match.id);

    const res = await postJson(app, `/rooms/${match.roomCode}/vote`, {
      user: b,
      votes: [{ submissionId: aSubId, score: 5 }],
    });
    expect(res.status).toBe(400);
  });
});
