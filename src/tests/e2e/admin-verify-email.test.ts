import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { buildTestApp, postJson } from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

describe('POST /admin/users/:id/verify-email', () => {
  const adminStub = {
    id: randomUUID(),
    handle: 'superadmin',
    email: 'superadmin@test.local',
    role: 'admin' as const,
    plan: 'free' as const,
  };

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
    // Re-insert admin stub after truncation so the app recognises it as admin.
    await seedTestUser(adminStub.handle, { role: adminStub.role, plan: adminStub.plan });
  });

  it('200 - verifies a real unverified user and flips emailVerified in the DB', async () => {
    const d = db();

    // Insert a real (non-guest) unverified user directly.
    const [target] = await d
      .insert(users)
      .values({
        handle: 'real-unverified',
        email: 'real-unverified@example.com',
        role: 'producer',
        plan: 'free',
        emailVerified: false,
      })
      .returning({ id: users.id, emailVerified: users.emailVerified });

    if (!target) throw new Error('Failed to insert target user');

    const app = buildTestApp({ asUser: adminStub });
    const { status, json } = await postJson<{
      id: string;
      emailVerified: boolean;
      alreadyVerified: boolean;
    }>(app, `/admin/users/${target.id}/verify-email`);

    expect(status).toBe(200);
    expect(json.emailVerified).toBe(true);
    expect(json.alreadyVerified).toBe(false);

    // Confirm the DB row was actually updated.
    const [updated] = await d
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, target.id))
      .limit(1);
    expect(updated?.emailVerified).toBe(true);
  });

  it('400 - rejects verify-email on a guest account and leaves DB unchanged', async () => {
    const d = db();

    // Mirror the pattern from phases.ts voteRoute - guest email ends @guest.local.
    const guestHandle = `audience-${randomUUID().slice(0, 8)}`;
    const inserted = await d.execute<{ id: string }>(
      sql`INSERT INTO users (id, email, handle, role)
            VALUES (gen_random_uuid(), ${`${guestHandle}@guest.local`}, ${guestHandle}, 'producer')
            ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle
            RETURNING id`,
    );
    const guest = inserted[0] as { id: string } | undefined;

    if (!guest) throw new Error('Failed to insert guest user');

    const app = buildTestApp({ asUser: adminStub });
    const { status, json } = await postJson<{ error: string; message: string }>(
      app,
      `/admin/users/${guest.id}/verify-email`,
    );

    expect(status).toBe(400);
    expect(json.error).toBe('guest_account');

    // Confirm the DB row was NOT touched (emailVerified stays null/false).
    const [row] = await d
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, guest.id))
      .limit(1);
    expect(row?.emailVerified).toBeFalsy();
  });

  it('200 - returns alreadyVerified=true when user is already verified (idempotent)', async () => {
    const d = db();

    // Insert a user who is already verified.
    const [target] = await d
      .insert(users)
      .values({
        handle: 'already-verified',
        email: 'already-verified@example.com',
        role: 'producer',
        plan: 'free',
        emailVerified: true,
      })
      .returning({ id: users.id });

    if (!target) throw new Error('Failed to insert target user');

    const app = buildTestApp({ asUser: adminStub });
    const { status, json } = await postJson<{
      id: string;
      emailVerified: boolean;
      alreadyVerified: boolean;
    }>(app, `/admin/users/${target.id}/verify-email`);

    expect(status).toBe(200);
    expect(json.emailVerified).toBe(true);
    expect(json.alreadyVerified).toBe(true);
  });
});
