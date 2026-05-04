// E2E tests for the email preferences feature.
//
// Covers:
//   - GET /me/email-prefs returns defaults for a new user (all true)
//   - PATCH /me/email-prefs updates one key, leaves the others intact
//   - PATCH /me/email-prefs with account_security: false returns 400
//   - sendIfOptedIn skips when pref is false, logs the skip event
//   - sendIfOptedIn calls through when pref is true
//   - tournamentStartReminderScan fires once per (tournament, user), no
//     duplicates on second run
//   - tournamentStartReminderScan skips entrants who opted out of
//     tournament_activity

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { sendIfOptedIn } from '../../mail/gated.js';
import {
  _resetReminderScanThrottleForTest,
  tournamentStartReminderScan,
} from '../../realtime/tick.js';
import { buildTestApp, getJson, patchJson, uniqueHandle } from '../harness.js';
import { seedTestFixtures, seedTestUser } from '../seed.js';

// Mock the mailer so no real SMTP connection is attempted.
vi.mock('../../mail/send.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../mail/send.js')>();
  return {
    ...original,
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };
});

import { sendEmail } from '../../mail/send.js';
const sendEmailMock = sendEmail as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a tournament starting in the 23h-25h window with status='open'. */
async function insertUpcomingTournament(genreId: string): Promise<{ id: string }> {
  const d = db();
  const startsAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const regClosesAt = new Date(Date.now() + 23 * 3600 * 1000).toISOString();
  const [row] = await d.execute<{ id: string }>(
    sql`INSERT INTO tournaments
          (name, genre_id, starts_at, registration_closes_at, max_entrants, auto_created)
        VALUES
          (${`Test Tournament ${randomUUID().slice(0, 8)}`}, ${genreId},
           ${startsAt}::timestamptz, ${regClosesAt}::timestamptz, 16, false)
        RETURNING id`,
  );
  if (!row) throw new Error('insertUpcomingTournament returned no row');
  return { id: (row as { id: string }).id };
}

/** Enroll a user in a tournament. */
async function enrollUser(tournamentId: string, userId: string): Promise<void> {
  const d = db();
  await d.execute(
    sql`INSERT INTO tournament_entries (tournament_id, user_id)
          VALUES (${tournamentId}, ${userId})
        ON CONFLICT DO NOTHING`,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('email preferences', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(() => {
    sendEmailMock.mockClear();
    _resetReminderScanThrottleForTest();
  });

  // ── GET /me/email-prefs ──────────────────────────────────────────────────

  it('GET /me/email-prefs returns all-true defaults for a new user', async () => {
    const user = await seedTestUser(uniqueHandle('ep-get'), { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: user });

    const { status, json } = await getJson<{
      tournament_activity: boolean;
      daily_activity: boolean;
      match_results: boolean;
      honor_alerts: boolean;
      account_security: boolean;
      billing: boolean;
    }>(app, '/me/email-prefs');

    expect(status).toBe(200);
    expect(json.tournament_activity).toBe(true);
    expect(json.daily_activity).toBe(true);
    expect(json.match_results).toBe(true);
    expect(json.honor_alerts).toBe(true);
    expect(json.account_security).toBe(true);
    expect(json.billing).toBe(true);
  });

  // ── PATCH /me/email-prefs ────────────────────────────────────────────────

  it('PATCH /me/email-prefs updates one key and leaves others intact', async () => {
    const user = await seedTestUser(uniqueHandle('ep-patch'), { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: user });

    const { status, json } = await patchJson<{
      tournament_activity: boolean;
      daily_activity: boolean;
      match_results: boolean;
      honor_alerts: boolean;
      account_security: boolean;
      billing: boolean;
    }>(app, '/me/email-prefs', { match_results: false });

    expect(status).toBe(200);
    expect(json.match_results).toBe(false);
    // All other keys remain true.
    expect(json.tournament_activity).toBe(true);
    expect(json.daily_activity).toBe(true);
    expect(json.honor_alerts).toBe(true);
    expect(json.account_security).toBe(true);
    expect(json.billing).toBe(true);

    // Verify persisted via a second GET.
    const { json: re } = await getJson<{ match_results: boolean }>(app, '/me/email-prefs');
    expect(re.match_results).toBe(false);
  });

  it('PATCH /me/email-prefs with account_security: false returns 400', async () => {
    const user = await seedTestUser(uniqueHandle('ep-lock'), { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: user });

    const { status, json } = await patchJson<{ error: string }>(app, '/me/email-prefs', {
      account_security: false,
    });

    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe('cannot_disable');
  });

  it('PATCH /me/email-prefs with billing: false returns 400', async () => {
    const user = await seedTestUser(uniqueHandle('ep-bill'), { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: user });

    const { status, json } = await patchJson<{ error: string }>(app, '/me/email-prefs', {
      billing: false,
    });

    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe('cannot_disable');
  });

  // ── sendIfOptedIn unit behaviour ─────────────────────────────────────────

  it('sendIfOptedIn calls through when pref is true', async () => {
    const d = db();
    // Create a user with tournament_activity = true (default).
    const handle = uniqueHandle('sio-on');
    const [userRow] = await d.execute<{ id: string }>(
      sql`INSERT INTO users (id, email, handle, role, plan, email_verified)
            VALUES (gen_random_uuid(), ${`${handle}@test.local`}, ${handle}, 'producer', 'free', true)
            RETURNING id`,
    );
    const userId = (userRow as { id: string }).id;

    await sendIfOptedIn(userId, 'tournament_activity', {
      to: `${handle}@test.local`,
      subject: 'Test',
      text: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]?.[0]).toMatchObject({ to: `${handle}@test.local` });
  });

  it('sendIfOptedIn skips when pref is false', async () => {
    const d = db();
    const handle = uniqueHandle('sio-off');
    const [userRow] = await d.execute<{ id: string }>(
      sql`INSERT INTO users
            (id, email, handle, role, plan, email_verified, email_prefs)
          VALUES
            (gen_random_uuid(), ${`${handle}@test.local`}, ${handle}, 'producer', 'free', true,
             '{"tournament_activity":false,"daily_activity":true,"match_results":true,"honor_alerts":true,"account_security":true,"billing":true}'::jsonb)
          RETURNING id`,
    );
    const userId = (userRow as { id: string }).id;

    await sendIfOptedIn(userId, 'tournament_activity', {
      to: `${handle}@test.local`,
      subject: 'Test',
      text: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ── tournamentStartReminderScan ───────────────────────────────────────────

  it('tournamentStartReminderScan fires once per (tournament, user) and does not duplicate', async () => {
    const { genreId } = await seedTestFixtures();
    const d = db();

    const { id: tournamentId } = await insertUpcomingTournament(genreId);

    // Two entrants.
    const userA = await seedTestUser(uniqueHandle('rem-a'), { plan: 'free', role: 'producer' });
    const userB = await seedTestUser(uniqueHandle('rem-b'), { plan: 'free', role: 'producer' });
    await enrollUser(tournamentId, userA.id);
    await enrollUser(tournamentId, userB.id);

    // Reset throttle so the scan actually runs.
    // We bypass the module-level throttle by directly testing the exported
    // function - the throttle only matters inside the tick loop, not here.
    await tournamentStartReminderScan();

    // Should have sent one email per entrant.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendEmailMock.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(recipients).toContain(userA.email);
    expect(recipients).toContain(userB.email);

    sendEmailMock.mockClear();

    // Second run: reminders_sent rows already exist -> no new emails.
    _resetReminderScanThrottleForTest();
    await tournamentStartReminderScan();
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Verify idempotency - still exactly 2 rows in reminders_sent.
    const sentRows = await d.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM tournament_reminders_sent WHERE tournament_id = ${tournamentId}`,
    );
    expect(Number((sentRows as Array<{ n: string }>)[0]?.n ?? 0)).toBe(2);
  });

  it('tournamentStartReminderScan skips entrants who opted out of tournament_activity', async () => {
    const { genreId } = await seedTestFixtures();
    const d = db();

    const { id: tournamentId } = await insertUpcomingTournament(genreId);

    // One opted-in, one opted-out.
    const userIn = await seedTestUser(uniqueHandle('rem-in'), { plan: 'free', role: 'producer' });
    const handleOut = uniqueHandle('rem-out');
    const [outRow] = await d.execute<{ id: string }>(
      sql`INSERT INTO users
            (id, email, handle, role, plan, email_verified, email_prefs)
          VALUES
            (gen_random_uuid(), ${`${handleOut}@test.local`}, ${handleOut}, 'producer', 'free', true,
             '{"tournament_activity":false,"daily_activity":true,"match_results":true,"honor_alerts":true,"account_security":true,"billing":true}'::jsonb)
          RETURNING id`,
    );
    const userOutId = (outRow as { id: string }).id;

    await enrollUser(tournamentId, userIn.id);
    await enrollUser(tournamentId, userOutId);

    await tournamentStartReminderScan();

    // Only the opted-in user should receive an email.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]?.[0]).toMatchObject({ to: userIn.email });
  });
});
