// E2E tests for the two-day Daily Challenge cycle.
//
// Lifecycle:
//   Day N     status='submit'  - producers submit; votes blocked.
//   Day N+1   status='vote'    - voting open; email batch sent to submitters.
//   Day N+2   status='results' - voting closed; tally and final_rank written.
//
// The mailer is mocked via vi.mock so tests run without mailpit and we can
// assert that sendEmail is called exactly once per submitter at rollover.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { dailyRolloverCheck } from '../../realtime/tick.js';
import {
  buildTestApp,
  getJson,
  getResults,
  getReveal,
  joinRoom,
  postJson,
  submitTrack,
  uniqueHandle,
} from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

// Mock the mailer so no real SMTP connection is attempted.
vi.mock('../../mail/send.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../mail/send.js')>();
  return {
    ...original,
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };
});

// Import the mock AFTER vi.mock so we get the spy reference.
import { sendEmail } from '../../mail/send.js';
const sendEmailMock = sendEmail as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a daily match directly with a backdated daily_date and given status. */
async function insertDailyMatch(opts: {
  genreId: string;
  status: 'submit' | 'vote' | 'results';
  dailyDate: string; // 'YYYY-MM-DD'
}): Promise<{ id: string; roomCode: string }> {
  const d = db();
  const roomCode = `DC${randomUUID().slice(0, 4).toUpperCase()}`;
  // daily-challenge route uses teamSize=1, teamCount=1 (constraint: 1..8).
  // The 20-submitter cap is enforced by application logic, not team_count.
  const [row] = await d.execute<{ id: string; room_code: string }>(
    sql`INSERT INTO matches
          (id, mode, status, room_code, team_size, team_count,
           primary_genre_id, daily_date, sample_mode)
        VALUES
          (gen_random_uuid(), 'daily', ${opts.status}::match_status, ${roomCode},
           1, 1, ${opts.genreId}, ${opts.dailyDate}::date, 'generated')
        RETURNING id, room_code`,
  );
  if (!row) throw new Error('insertDailyMatch returned no row');
  return {
    id: (row as { id: string; room_code: string }).id,
    roomCode: (row as { id: string; room_code: string }).room_code,
  };
}

/** Insert a user + submission for a given match. Returns submissionId. */
async function insertSubmission(opts: {
  matchId: string;
  genreId: string;
  handle: string;
  email?: string;
}): Promise<{ userId: string; submissionId: string }> {
  const d = db();
  const email = opts.email ?? `${opts.handle}@test.local`;
  const [userRow] = await d.execute<{ id: string }>(
    sql`INSERT INTO users (id, email, handle, role, plan, email_verified)
          VALUES (gen_random_uuid(), ${email}, ${opts.handle}, 'producer', 'paid', true)
          ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle
          RETURNING id`,
  );
  const userId = (userRow as { id: string }).id;

  const [subRow] = await d.execute<{ id: string }>(
    sql`INSERT INTO submissions
          (id, match_id, user_id, genre_id, audio_url, duration_sec, title, is_public)
        VALUES
          (gen_random_uuid(), ${opts.matchId}, ${userId}, ${opts.genreId},
           'https://s3.example.com/test.mp3', 120, 'test beat', true)
        RETURNING id`,
  );
  const submissionId = (subRow as { id: string }).id;

  // Seat the user so the min-matches exemption applies when they vote.
  await d.execute(
    sql`INSERT INTO match_players (match_id, user_id, is_spectator)
          VALUES (${opts.matchId}, ${userId}, false)
          ON CONFLICT DO NOTHING`,
  );

  return { userId, submissionId };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Daily Challenge two-day cycle', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    sendEmailMock.mockClear();
    await resetMatchState();
    await seedTestFixtures();
  });

  // ── Rollover: submit -> vote ─────────────────────────────────────────────

  it('dailyRolloverCheck: flips submit->vote for matches with daily_date < today', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const { id: matchId } = await insertDailyMatch({
      genreId,
      status: 'submit',
      dailyDate: yesterday,
    });
    // At least one submission - otherwise the rollover cancels the match
    // instead of flipping it to vote (separate test below).
    await insertSubmission({ matchId, genreId, handle: uniqueHandle('rc-sub-flip') });

    await dailyRolloverCheck();

    const rows = await d.execute<{ status: string }>(
      sql`SELECT status FROM matches WHERE id = ${matchId}`,
    );
    expect((rows as Array<{ status: string }>)[0]?.status).toBe('vote');
  });

  it('dailyRolloverCheck: cancels submit-phase daily with zero submissions', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const { id: matchId } = await insertDailyMatch({
      genreId,
      status: 'submit',
      dailyDate: yesterday,
    });
    // Intentionally NO submissions inserted.

    await dailyRolloverCheck();

    const rows = await d.execute<{ status: string; ended_at: string | null }>(
      sql`SELECT status, ended_at FROM matches WHERE id = ${matchId}`,
    );
    const row = (rows as Array<{ status: string; ended_at: string | null }>)[0];
    expect(row?.status).toBe('cancelled');
    expect(row?.ended_at).not.toBeNull();
  });

  it('dailyRolloverCheck: does NOT flip a submit match that is still today', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const today = new Date().toISOString().slice(0, 10);

    const { id: matchId } = await insertDailyMatch({
      genreId,
      status: 'submit',
      dailyDate: today,
    });

    await dailyRolloverCheck();

    const rows = await d.execute<{ status: string }>(
      sql`SELECT status FROM matches WHERE id = ${matchId}`,
    );
    expect((rows as Array<{ status: string }>)[0]?.status).toBe('submit');
  });

  // ── Rollover: vote -> results ────────────────────────────────────────────

  it('dailyRolloverCheck: flips vote->results and writes final_rank for daily_date < today-1', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    // Two days ago so the vote window has closed.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

    const { id: matchId } = await insertDailyMatch({
      genreId,
      status: 'vote',
      dailyDate: twoDaysAgo,
    });
    await insertSubmission({ matchId, genreId, handle: uniqueHandle('rc-sub') });

    await dailyRolloverCheck();

    const matchRow = await d.execute<{ status: string }>(
      sql`SELECT status FROM matches WHERE id = ${matchId}`,
    );
    expect((matchRow as Array<{ status: string }>)[0]?.status).toBe('results');

    const subRow = await d.execute<{ final_rank: number }>(
      sql`SELECT final_rank FROM submissions WHERE match_id = ${matchId}`,
    );
    expect((subRow as Array<{ final_rank: number }>)[0]?.final_rank).toBe(1);
  });

  it('dailyRolloverCheck: vote match that is still yesterday stays at vote', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const { id: matchId } = await insertDailyMatch({
      genreId,
      status: 'vote',
      dailyDate: yesterday,
    });

    await dailyRolloverCheck();

    const rows = await d.execute<{ status: string }>(
      sql`SELECT status FROM matches WHERE id = ${matchId}`,
    );
    expect((rows as Array<{ status: string }>)[0]?.status).toBe('vote');
  });

  // ── Vote gate ────────────────────────────────────────────────────────────

  it('vote on a submit-phase daily returns 400', async () => {
    const { genreId } = await seedTestFixtures();

    const paidUser = await seedTestUser(uniqueHandle('vg-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: paidUser });

    // Get or create today's daily match via the GET endpoint.
    const { json: dcGet } = await getJson<{ roomCode: string }>(app, '/daily-challenge');
    const code = dcGet.roomCode;
    if (!code) throw new Error('no roomCode from /daily-challenge');

    // Submit a track so we have a submission to vote on.
    const aUser = await seedTestUser(uniqueHandle('vg-a'), { plan: 'paid', role: 'producer' });
    const appA = buildTestApp({ asUser: aUser });
    await joinRoom(appA, code, aUser.handle);
    const subId = await submitTrack(appA, code, aUser.handle, { durationSec: 120 });

    // Voting during 'submit' phase must be rejected.
    const voteRes = await postJson(app, `/rooms/${code}/vote`, {
      user: paidUser.handle,
      votes: [{ submissionId: subId, score: 4 }],
    });
    expect(voteRes.status).toBe(400);
  });

  it('vote on a vote-phase daily as a signed-in user returns 200', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // Insert a match already in 'vote' phase.
    const { id: matchId, roomCode: code } = await insertDailyMatch({
      genreId,
      status: 'vote',
      dailyDate: yesterday,
    });

    // Submitter A (who submitted yesterday - already seated).
    const { userId: aUserId, submissionId: subA } = await insertSubmission({
      matchId,
      genreId,
      handle: uniqueHandle('vp-a'),
    });

    // Voter B: a different signed-in active user.
    const bUser = await seedTestUser(uniqueHandle('vp-b'), { plan: 'paid', role: 'producer' });
    const appB = buildTestApp({ asUser: bUser });

    const voteRes = await postJson(appB, `/rooms/${code}/vote`, {
      user: bUser.handle,
      votes: [{ submissionId: subA, score: 5 }],
    });
    expect(voteRes.status).toBe(200);
    expect((voteRes.json as { accepted: number }).accepted).toBe(1);

    // Confirm vote is stored.
    const stored = await d.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM votes WHERE match_id = ${matchId}`,
    );
    expect(Number((stored as Array<{ n: string }>)[0]?.n ?? 0)).toBe(1);
  });

  // ── Submit gate ──────────────────────────────────────────────────────────

  it('submit on a vote-phase daily returns 400 submit_window_closed', async () => {
    const { genreId } = await seedTestFixtures();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const { roomCode: code } = await insertDailyMatch({
      genreId,
      status: 'vote',
      dailyDate: yesterday,
    });

    const paidUser = await seedTestUser(uniqueHandle('sg-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: paidUser });
    await joinRoom(app, code, paidUser.handle);

    // Attempt submission during vote phase.
    const urlRes = await postJson<{ key: string }>(app, `/rooms/${code}/upload-url`, {
      user: paidUser.handle,
      contentType: 'audio/mpeg',
    });
    const finalizeRes = await postJson<{ error: string }>(app, `/rooms/${code}/submission`, {
      user: paidUser.handle,
      key: urlRes.json.key,
      durationSec: 120,
    });
    expect(finalizeRes.status).toBe(400);
    expect(finalizeRes.json.error).toBe('submit_window_closed');
  });

  // ── Self-vote ────────────────────────────────────────────────────────────

  it('self-vote on a vote-phase daily is silently dropped', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const { id: matchId, roomCode: code } = await insertDailyMatch({
      genreId,
      status: 'vote',
      dailyDate: yesterday,
    });

    // One submitter who also tries to vote for their own track.
    const aUser = await seedTestUser(uniqueHandle('sv-a'), { plan: 'paid', role: 'producer' });
    const { submissionId: subA } = await insertSubmission({
      matchId,
      genreId,
      handle: aUser.handle,
      email: aUser.email,
    });

    const appA = buildTestApp({ asUser: aUser });
    const voteRes = await postJson(appA, `/rooms/${code}/vote`, {
      user: aUser.handle,
      votes: [{ submissionId: subA, score: 5 }],
    });
    // Request accepted (200) but vote count is 0 - self-vote silently dropped.
    expect(voteRes.status).toBe(200);
    expect((voteRes.json as { accepted: number }).accepted).toBe(0);

    const stored = await d.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM votes WHERE match_id = ${matchId}`,
    );
    expect(Number((stored as Array<{ n: string }>)[0]?.n ?? 0)).toBe(0);
  });

  // ── Vote-open email ──────────────────────────────────────────────────────

  it('dailyRolloverCheck sends one email per submitter at submit->vote transition', async () => {
    const { genreId } = await seedTestFixtures();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const { id: matchId } = await insertDailyMatch({
      genreId,
      status: 'submit',
      dailyDate: yesterday,
    });

    // Two submitters.
    await insertSubmission({
      matchId,
      genreId,
      handle: uniqueHandle('em-a'),
      email: 'em-a@test.local',
    });
    await insertSubmission({
      matchId,
      genreId,
      handle: uniqueHandle('em-b'),
      email: 'em-b@test.local',
    });

    await dailyRolloverCheck();

    // sendEmail should have been called once per submitter.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);

    // Each call should be addressed to one of the submitter emails.
    const recipients = sendEmailMock.mock.calls.map((call) => (call[0] as { to: string }).to);
    expect(recipients).toContain('em-a@test.local');
    expect(recipients).toContain('em-b@test.local');

    // Sender should be the support address.
    for (const call of sendEmailMock.mock.calls) {
      expect((call[0] as { from: string }).from).toBe('support@prodbattle.com');
    }
  });

  it('dailyRolloverCheck: no email sent at vote->results transition', async () => {
    const { genreId } = await seedTestFixtures();
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

    const { id: matchId } = await insertDailyMatch({
      genreId,
      status: 'vote',
      dailyDate: twoDaysAgo,
    });
    await insertSubmission({ matchId, genreId, handle: uniqueHandle('ne-a') });

    await dailyRolloverCheck();

    // No vote-open emails at the vote->results step.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
