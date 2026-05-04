// Integration test: dailyRolloverCheck uses a real wall-clock comparison
// (WHERE daily_date < today). This suite verifies the end-to-end flow without
// mocking Date.now() - instead it back-dates the match's daily_date so the
// SQL WHERE clause fires on today's real date.
//
// Requires: running Postgres on DATABASE_URL (prod_battle_test) and
// optionally mailpit on MAILPIT_URL (http://localhost:8025).
// If mailpit is unreachable, the email-arrival assertions are skipped with a
// console.warn (mirrors auth-flow.test.ts pattern).
//
// Two-step cycle exercised:
//   Step A: daily_date = today-1, status='submit'  -> status flips to 'vote',
//           vote-open email sent to each submitter.
//   Step B: daily_date = today-2, status='vote'    -> status flips to 'results',
//           final_rank assigned to every submission.

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { matches, submissions, users } from '../../db/schema.js';
import { dailyRolloverCheck } from '../../realtime/tick.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
const SMTP_PORT = process.env.SMTP_PORT ?? '1025';

// Poll mailpit for a message to the given address, returning the first match.
// Returns null if none arrived within timeoutMs.
async function pollMailpit(
  toEmail: string,
  subjectFragment: string,
  timeoutMs = 8_000,
): Promise<{ id: string } | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `${MAILPIT_URL}/api/v1/messages?query=${encodeURIComponent(`to:${toEmail}`)}`,
    ).catch(() => null);
    if (res?.ok) {
      type Msg = { ID: string; Subject: string; To: { Address: string }[] };
      const json = (await res.json()) as { messages: Msg[] };
      const match = json.messages.find(
        (m) => m.To.some((t) => t.Address === toEmail) && m.Subject.includes(subjectFragment),
      );
      if (match) return { id: match.ID };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function deleteMailpitMessages(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await fetch(`${MAILPIT_URL}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: ids }),
  }).catch(() => {});
}

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
  let mailpitOk = false;
  let genreId: string;
  const mailpitMsgIds: string[] = [];

  // Set SMTP env vars so nodemailer sends to local mailpit.
  // These are set process-wide before any test runs. If already set,
  // we leave them alone (allows CI override).
  beforeAll(async () => {
    if (!process.env.SMTP_HOST) process.env.SMTP_HOST = SMTP_HOST;
    if (!process.env.SMTP_PORT) process.env.SMTP_PORT = SMTP_PORT;

    // Probe mailpit reachability.
    try {
      const r = await fetch(`${MAILPIT_URL}/api/v1/messages`);
      mailpitOk = r.ok;
    } catch {
      mailpitOk = false;
    }
    if (!mailpitOk) {
      console.warn(
        `[daily-rollover-clock] mailpit not reachable at ${MAILPIT_URL} - email assertions will be skipped`,
      );
    }

    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;
  });

  beforeEach(async () => {
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;
  });

  afterAll(async () => {
    // Best-effort: delete any messages we left in mailpit.
    await deleteMailpitMessages(mailpitMsgIds);
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

    // Assert: vote-open email landed in mailpit for each submitter.
    if (mailpitOk) {
      for (const u of [userA, userB]) {
        const msg = await pollMailpit(u.email, 'voting is now open');
        expect(msg, `expected vote-open email for ${u.email}`).not.toBeNull();
        if (msg) mailpitMsgIds.push(msg.id);
      }
    } else {
      console.warn('[daily-rollover-clock] skipping email assertion - mailpit unreachable');
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
