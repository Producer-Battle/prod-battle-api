// E2E tests for POST /me/claim-guest-handle.
//
// Each test case seeds a fresh caller (via seedTestUser) and a guest row
// directly in the DB, exercises the endpoint, then lets resetMatchState
// wipe everything before the next test.

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { accounts, submissions, users } from '../../db/schema.js';
import { buildTestApp, postJson } from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

// ─── Helper: insert a bare guest row ─────────────────────────────────────────

async function seedGuestUser(handle: string): Promise<{ id: string; handle: string }> {
  const d = db();
  const email = `${handle}@guest.local`;
  const [row] = await d
    .insert(users)
    .values({
      handle,
      email,
      role: 'producer',
      plan: 'free',
      emailVerified: false,
      status: 'active',
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    const [existing] = await d.select().from(users).where(eq(users.handle, handle)).limit(1);
    if (!existing) throw new Error(`[seed] seedGuestUser: could not insert or find "${handle}"`);
    return { id: existing.id, handle: existing.handle };
  }
  return { id: row.id, handle: row.handle };
}

// ─── Helper: insert an accounts row to simulate a real (credentials) account ─

async function seedAccountRow(userId: string): Promise<void> {
  const d = db();
  await d
    .insert(accounts)
    .values({
      userId,
      accountId: userId,
      providerId: 'credential',
      password: 'fake-bcrypt-hash',
    })
    .onConflictDoNothing();
}

// ─── Helper: insert a minimal submission linked to a user ─────────────────────

async function seedSubmissionForUser(
  userId: string,
  matchId: string,
  genreId: string,
): Promise<string> {
  const d = db();
  const [row] = await d
    .insert(submissions)
    .values({
      matchId,
      userId,
      genreId,
      audioUrl: `http://localhost:9000/pb-test/tracks/${userId}.wav`,
      durationSec: 30,
      title: 'guest-track',
    })
    .returning({ id: submissions.id });
  if (!row) throw new Error('[seed] seedSubmissionForUser: no row returned');
  return row.id;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('POST /me/claim-guest-handle', () => {
  let genreId: string;

  beforeAll(async () => {
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;
  });

  beforeEach(async () => {
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;
  });

  // ── 1. Happy path ─────────────────────────────────────────────────────────

  it('200: merges guest history and transfers handle to caller', async () => {
    const caller = await seedTestUser('claim-caller-a', { plan: 'free', role: 'producer' });
    const guest = await seedGuestUser('gritty-808-test');

    // Seed a match so we have a real match_id for the submission.
    const d = db();
    const { matches, matchPlayers: mpTable, genres } = await import('../../db/schema.js');
    const { sql } = await import('drizzle-orm');

    // Use the seeded genre for a minimal match row.
    const [matchRow] = await d
      .insert(matches)
      .values({
        mode: 'quickplay',
        status: 'results',
        teamSize: 1,
        teamCount: 2,
        primaryGenreId: genreId,
        submitSeconds: 60,
      })
      .returning({ id: matches.id });
    if (!matchRow) throw new Error('match insert failed');
    const matchId = matchRow.id;

    // Guest is a player in that match.
    await d.insert(mpTable).values({ matchId, userId: guest.id });

    // Guest has a submission.
    const subId = await seedSubmissionForUser(guest.id, matchId, genreId);

    const app = buildTestApp({ asUser: caller });
    const { status, json } = await postJson<{
      newHandle: string;
      stats: { matchesMerged: number; submissionsMerged: number; votesMerged: number };
    }>(app, '/me/claim-guest-handle', { guestHandle: 'gritty-808-test' });

    expect(status).toBe(200);
    expect(json.newHandle).toBe('gritty-808-test');
    expect(json.stats.matchesMerged).toBe(1);
    expect(json.stats.submissionsMerged).toBe(1);
    expect(json.stats.votesMerged).toBe(0);

    // Guest row must be gone.
    const [guestRow] = await d
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, guest.id))
      .limit(1);
    expect(guestRow).toBeUndefined();

    // Caller's handle must be updated.
    const [callerRow] = await d
      .select({ handle: users.handle })
      .from(users)
      .where(eq(users.id, caller.id))
      .limit(1);
    expect(callerRow?.handle).toBe('gritty-808-test');

    // Submission must now belong to caller.
    const [subRow] = await d
      .select({ userId: submissions.userId })
      .from(submissions)
      .where(eq(submissions.id, subId))
      .limit(1);
    expect(subRow?.userId).toBe(caller.id);
  });

  // ── 2. 404 when guest handle doesn't exist ────────────────────────────────

  it('404 when guestHandle does not exist', async () => {
    const caller = await seedTestUser('claim-caller-b', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: caller });

    const { status, json } = await postJson<{ error: string }>(app, '/me/claim-guest-handle', {
      guestHandle: 'no-such-handle-xyz',
    });

    expect(status).toBe(404);
    expect(json.error).toBe('guest_not_found');
  });

  // ── 3. 409 when target has an accounts row ────────────────────────────────

  it('409 when target has an accounts row (real account)', async () => {
    const caller = await seedTestUser('claim-caller-c', { plan: 'free', role: 'producer' });
    // Create a guest-email user but also give them an accounts row.
    const fakeRealUser = await seedGuestUser('almost-guest-test');
    await seedAccountRow(fakeRealUser.id);

    const app = buildTestApp({ asUser: caller });
    const { status, json } = await postJson<{ error: string }>(app, '/me/claim-guest-handle', {
      guestHandle: 'almost-guest-test',
    });

    expect(status).toBe(409);
    expect(json.error).toBe('guest_is_real_account');
  });

  // ── 4. 409 when target email doesn't end in @guest.local ─────────────────

  it('409 when target email is not @guest.local', async () => {
    const caller = await seedTestUser('claim-caller-d', { plan: 'free', role: 'producer' });
    // A real-looking user who happens to have a non-guest email.
    const realUser = await seedTestUser('real-user-handle', {
      plan: 'free',
      role: 'producer',
    });

    const app = buildTestApp({ asUser: caller });
    const { status, json } = await postJson<{ error: string }>(app, '/me/claim-guest-handle', {
      guestHandle: realUser.handle,
    });

    expect(status).toBe(409);
    expect(json.error).toBe('guest_is_real_account');
  });

  // ── 5. 400 when the handle is already held by another non-guest user ──────

  it('400 when caller already holds the target handle', async () => {
    // We seed a caller whose handle IS the target - simulates "handle_collision"
    // from the perspective of "caller already uses that handle".
    const caller = await seedTestUser('same-handle-caller', { plan: 'free', role: 'producer' });

    // There is no guest with that handle - just the caller. So 404 fires, not
    // 400. To hit the 400 path specifically, we need a guest with a handle
    // that the caller ALSO holds - which is impossible due to the unique index.
    // The 400 path is "caller.handle === normalised". Let's verify: create a
    // guest with the exact same handle as caller - impossible due to unique
    // constraint, so we instead verify the endpoint returns 400 when the
    // caller's own stub handle matches the requested handle.
    //
    // We simulate this by stubbing the caller with a handle that matches what
    // we request, using a guest that we cannot create (unique conflict), so
    // we instead directly verify behavior: caller requesting their OWN handle
    // returns 404 (no guest found). For the "another non-guest holds it" case,
    // the handle_collision check fires when caller.handle === normalised.
    //
    // In practice, the unique index prevents two live users from ever sharing
    // a handle. The 400 guard exists for the (caller.handle === normalised)
    // sub-case where no guest-with-that-handle can exist. We test it directly
    // by injecting a caller stub that already owns the handle we query.
    const guest = await seedGuestUser('shared-handle-probe');
    // Now manually update the caller's handle in DB to match the guest's
    // BEFORE we build the app, so the stubbed user object is stale but the
    // endpoint reads c.var.user.handle which comes from the stub.
    // The fastest path: just use a stub with handle = 'shared-handle-probe'
    // but the guest also exists, so it will pass the 404 check. Let's test
    // this differently: use a fresh caller and point their stub handle at the
    // guest handle to exercise the self-collision guard.
    const stubbedCaller = { ...caller, handle: guest.handle };
    const app = buildTestApp({ asUser: stubbedCaller });

    const { status, json } = await postJson<{ error: string }>(app, '/me/claim-guest-handle', {
      guestHandle: guest.handle,
    });

    // The endpoint checks if user.handle === normalised AFTER validating the
    // guest exists; should return 400 handle_collision.
    expect(status).toBe(400);
    expect(json.error).toBe('handle_collision');
  });

  // ── 6. 429 rate limit ────────────────────────────────────────────────────

  it('429 when called twice within the rate-limit window', async () => {
    // The FakeRedis in setup.ts uses an in-memory Map. The first incr returns
    // 1 (allowed), the second returns 2 (blocked). Because the rate-limit key
    // is per-user-id, we use a fresh user here so the counter starts at 0.
    const caller = await seedTestUser('rl-claim-caller', { plan: 'free', role: 'producer' });
    const guest = await seedGuestUser('rl-guest-handle');

    const app = buildTestApp({ asUser: caller });

    // First call - should hit the guest check and return 200 (or some non-429).
    // (We don't need it to succeed fully, just pass the rate limit gate.)
    const first = await postJson<{ error?: string }>(app, '/me/claim-guest-handle', {
      guestHandle: guest.handle,
    });
    // First call may return 200 (happy path) or another non-429.
    expect(first.status).not.toBe(429);

    // Second call with ANY guest handle - should hit 429 from the rate limit
    // before doing any DB work.
    const second = await postJson<{ error: string }>(app, '/me/claim-guest-handle', {
      guestHandle: 'anything-goes-here',
    });
    expect(second.status).toBe(429);
    expect(second.json.error).toBe('already_claimed_recently');
  });
});
