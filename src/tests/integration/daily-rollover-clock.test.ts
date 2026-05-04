// Integration test: dailyRolloverCheck uses a real wall-clock comparison
// (WHERE daily_date < today). This suite verifies the end-to-end flow without
// mocking Date.now() - it back-dates the match's daily_date so the SQL WHERE
// clause fires on today's real date.
//
// The mailer is mocked via vi.mock so the test does not depend on a running
// SMTP server. CI has no mailpit; an unmocked nodemailer.sendMail call hangs
// for 30+ seconds trying to connect to localhost:1025 and timed out the
// whole suite. The "integration" purpose preserved here is real DB + real
// wall-clock; the email-was-sent assertion now reads the mock spy.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { matches, submissions } from '../../db/schema.js';
import { dailyRolloverCheck } from '../../realtime/tick.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

vi.mock('../../mail/send.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../mail/send.js')>();
  return {
    ...original,
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };
});

import { sendEmail } from '../../mail/send.js';
const sendEmailMock = sendEmail as ReturnType<typeof vi.fn>;

// Insert a minimal daily match in the given status with daily_date offset from today.
// daysAgo = 1 means daily_date = today - 1 day, i.e. "yesterday".
// genreId is required because primary_genre_id has a FK + NOT NULL constraint.
async function insertDailyMatch(opts: {
  status: 'submit' | 'vote' | 'results';
  daysAgo: number;
  genreId: string;
}): Promise<string> {
  const d = db();
  const rows = await d.execute<{ id: string }>(
    sql`INSERT INTO matches
          (mode, status, daily_date, sample_mode, room_code,
           team_size, team_count, primary_genre_id)
        VALUES (
          'daily',
          ${opts.status}::match_status,
          (CURRENT_DATE - ${String(opts.daysAgo)}::int)::date,
          'none'::sample_mode,
          upper(substr(md5(random()::text), 1, 6)),
          1,
          1,
          ${opts.genreId}
        )
        RETURNING id`,
  );
  const row = (rows as Array<{ id: string }>)[0];
  if (!row) throw new Error('[test] failed to insert daily match');
  return row.id;
}

// Insert a submission row for the given match + user.
async function insertSubmission(matchId: string, userId: string, genreId: string): Promise<string> {
  const d = db();
  const rows = await d.execute<{ id: string }>(
    sql`INSERT INTO submissions (match_id, user_id, genre_id, audio_url, duration_sec)
        VALUES (${matchId}, ${userId}, ${genreId}, 'https://example.com/fake.mp3', 120)
        RETURNING id`,
  );
  const row = (rows as Array<{ id: string }>)[0];
  if (!row) throw new Error('[test] failed to insert submission');
  return row.id;
}

describe('dailyRolloverCheck (real clock / no Date.now mock)', () => {
  let genreId: string;

  beforeAll(async () => {
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;
  });

  beforeEach(async () => {
    sendEmailMock.mockClear();
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;
  });

  // -----------------------------------------------------------------------
  // Step A: submit -> vote
  // -----------------------------------------------------------------------
  it('flips submit->vote and sends vote-open emails when daily_date < today', async () => {
    // Arrange: two submitters for a back-dated daily match.
    const userA = await seedTestUser('rollover-a', { plan: 'paid', role: 'producer' });
    const userB = await seedTestUser('rollover-b', { plan: 'paid', role: 'producer' });

    const matchId = await insertDailyMatch({ status: 'submit', daysAgo: 1, genreId });
    await insertSubmission(matchId, userA.id, genreId);
    await insertSubmission(matchId, userB.id, genreId);

    // Act: call the real rollover without any Date.now mock.
    await dailyRolloverCheck();

    // Assert: match status flipped to 'vote'.
    const [row] = await db()
      .select({ status: matches.status })
      .from(matches)
      .where(sql`${matches.id} = ${matchId}`)
      .limit(1);
    expect(row?.status).toBe('vote');

    // Assert: vote-open email mock was called once per submitter with the
    // right subject. Subject contains "voting is now open" per touchpoints.ts.
    const calls = sendEmailMock.mock.calls.map((c) => c[0] as { to: string; subject: string });
    const recipients = calls.map((c) => c.to).sort();
    expect(recipients).toEqual([userA.email, userB.email].sort());
    for (const c of calls) {
      expect(c.subject.toLowerCase()).toContain('voting is now open');
    }
  });

  // -----------------------------------------------------------------------
  // Step B: vote -> results (tallyResults assigns final_rank)
  // -----------------------------------------------------------------------
  it('flips vote->results and assigns final_rank when daily_date < today-1', async () => {
    // Arrange: two submitters, match already at 'vote', daily_date 2 days ago.
    const userA = await seedTestUser('rollover-c', { plan: 'paid', role: 'producer' });
    const userB = await seedTestUser('rollover-d', { plan: 'paid', role: 'producer' });

    const matchId = await insertDailyMatch({ status: 'vote', daysAgo: 2, genreId });
    const subAId = await insertSubmission(matchId, userA.id, genreId);
    const subBId = await insertSubmission(matchId, userB.id, genreId);

    // Act.
    await dailyRolloverCheck();

    // Assert: match status is now 'results'.
    const [matchRow] = await db()
      .select({ status: matches.status })
      .from(matches)
      .where(sql`${matches.id} = ${matchId}`)
      .limit(1);
    expect(matchRow?.status).toBe('results');

    // Assert: both submissions have a non-null final_rank.
    const subRows = await db()
      .select({ id: submissions.id, finalRank: submissions.finalRank })
      .from(submissions)
      .where(sql`${submissions.matchId} = ${matchId}`);

    expect(subRows).toHaveLength(2);
    for (const s of subRows) {
      expect(
        s.finalRank,
        `submission ${s.id} should have a final_rank after rollover`,
      ).not.toBeNull();
      expect(s.finalRank).toBeGreaterThanOrEqual(1);
    }

    // Ranks must be 1 and 2 (no ties with zero votes both get ranked sequentially).
    const ranks = subRows.map((s) => s.finalRank).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ranks).toEqual([1, 2]);

    // Paranoia: confirm step A did NOT re-run (match was already at 'vote').
    // There should be no new email in mailpit for these users during this run
    // because step A's WHERE clause checks status='submit'.
    // (We just verify the step B path by checking results - email step is A only.)
    void subAId;
    void subBId;
  });

  // -----------------------------------------------------------------------
  // Idempotency guard
  // -----------------------------------------------------------------------
  it('is idempotent: running rollover twice on same data does not double-flip', async () => {
    const userA = await seedTestUser('rollover-idem-a', { plan: 'paid', role: 'producer' });
    const matchId = await insertDailyMatch({ status: 'submit', daysAgo: 1, genreId });
    await insertSubmission(matchId, userA.id, genreId);

    // First run: submit -> vote.
    await dailyRolloverCheck();

    // Second run: match is now 'vote' with daily_date = yesterday.
    // Step A WHERE requires status='submit', so it will NOT touch this match.
    // Step B WHERE requires daily_date < today-1, yesterday does not qualify yet.
    await dailyRolloverCheck();

    const [row] = await db()
      .select({ status: matches.status })
      .from(matches)
      .where(sql`${matches.id} = ${matchId}`)
      .limit(1);
    // Should remain at 'vote' - not double-advanced to 'results'.
    expect(row?.status).toBe('vote');
  });
});
