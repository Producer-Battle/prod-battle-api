import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../../middleware/session.js';
import { buildTestApp, getJson, postJson } from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

type UserStub = {
  id: string;
  handle: string;
  email: string;
  role: AuthUser['role'];
  plan: AuthUser['plan'];
};

let userStub: UserStub;
let adminStub: UserStub;
let otherUserStub: UserStub;

beforeEach(async () => {
  await resetMatchState();
  await seedTestFixtures();

  const u = await seedTestUser('supp-user', { role: 'producer', plan: 'free' });
  userStub = u;

  const a = await seedTestUser('supp-admin', { role: 'admin', plan: 'free' });
  adminStub = a;

  const o = await seedTestUser('supp-other', { role: 'producer', plan: 'free' });
  otherUserStub = o;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createTicket(
  app: ReturnType<typeof buildTestApp>,
  subject = 'Test subject',
  body = 'This is the body text with at least ten chars.',
) {
  return postJson<{ id: string }>(app, '/support/tickets', { subject, body });
}

// ─── Auth guards ──────────────────────────────────────────────────────────────

describe('anonymous requests are rejected', () => {
  it('401 on POST /support/tickets', async () => {
    const app = buildTestApp();
    const { status } = await createTicket(app);
    expect(status).toBe(401);
  });

  it('401 on GET /support/tickets', async () => {
    const app = buildTestApp();
    const { status } = await getJson(app, '/support/tickets');
    expect(status).toBe(401);
  });

  it('401 on GET /support/tickets/:id', async () => {
    const app = buildTestApp();
    const { status } = await getJson(app, `/support/tickets/${randomUUID()}`);
    expect(status).toBe(401);
  });

  it('401 on POST /support/tickets/:id/reply', async () => {
    const app = buildTestApp();
    const { status } = await postJson(app, `/support/tickets/${randomUUID()}/reply`, {
      body: 'hello',
    });
    expect(status).toBe(401);
  });
});

// ─── Create ticket ────────────────────────────────────────────────────────────

describe('POST /support/tickets', () => {
  it('201 creates a ticket with body as first reply', async () => {
    const app = buildTestApp({ asUser: userStub });
    const { status, json } = await createTicket(app);
    expect(status).toBe(201);
    expect(json.id).toBeDefined();
  });

  it('validates subject min length', async () => {
    const app = buildTestApp({ asUser: userStub });
    const { status } = await createTicket(app, 'ab', 'This is a valid body with enough chars.');
    expect(status).toBe(400);
  });

  it('validates body min length', async () => {
    const app = buildTestApp({ asUser: userStub });
    const { status } = await createTicket(app, 'Valid subject', 'Too short');
    expect(status).toBe(400);
  });
});

// ─── Quota exhaustion ─────────────────────────────────────────────────────────

describe('ticket quota', () => {
  it('429 ticket_quota_exhausted on the 5th create in the same UTC day', async () => {
    const app = buildTestApp({ asUser: userStub });

    for (let i = 0; i < 4; i++) {
      const { status } = await createTicket(app, `Ticket ${i + 1}`, 'Body text long enough here.');
      expect(status).toBe(201);
    }

    const { status, json } = await createTicket(app, 'Fifth ticket', 'Body text long enough.');
    expect(status).toBe(429);
    expect((json as unknown as { error: string }).error).toBe('ticket_quota_exhausted');
  });

  it('quotaRemaining in list response decreases as tickets are created', async () => {
    const app = buildTestApp({ asUser: userStub });

    const r0 = await getJson<{ items: unknown[]; quotaRemaining: number }>(app, '/support/tickets');
    expect(r0.json.quotaRemaining).toBe(4);

    await createTicket(app, 'One ticket', 'Body text is long enough here to pass validation.');

    const r1 = await getJson<{ items: unknown[]; quotaRemaining: number }>(app, '/support/tickets');
    expect(r1.json.quotaRemaining).toBe(3);
  });
});

// ─── List + detail ────────────────────────────────────────────────────────────

describe('GET /support/tickets', () => {
  it('returns tickets for authenticated user only', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const otherApp = buildTestApp({ asUser: otherUserStub });

    await createTicket(userApp, 'User ticket', 'Body text long enough to pass validation.');
    await createTicket(otherApp, 'Other ticket', 'Body text long enough to pass validation.');

    const { json } = await getJson<{ items: Array<{ id: string }> }>(userApp, '/support/tickets');
    expect(json.items).toHaveLength(1);
  });
});

describe('GET /support/tickets/:id', () => {
  it('returns ticket detail with replies', async () => {
    const app = buildTestApp({ asUser: userStub });
    const { json: created } = await createTicket(
      app,
      'Detail subject',
      'Body text long enough here.',
    );

    const { status, json } = await getJson<{
      id: string;
      subject: string;
      replies: Array<{ body: string }>;
    }>(app, `/support/tickets/${created.id}`);

    expect(status).toBe(200);
    expect(json.subject).toBe('Detail subject');
    expect(json.replies).toHaveLength(1);
    expect(json.replies[0]?.body).toBe('Body text long enough here.');
  });

  it('403 when another user tries to read the ticket', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const otherApp = buildTestApp({ asUser: otherUserStub });

    const { json: created } = await createTicket(
      userApp,
      'Private ticket',
      'Body text long enough here.',
    );
    const { status } = await getJson(otherApp, `/support/tickets/${created.id}`);
    expect(status).toBe(403);
  });

  it('404 for nonexistent ticket', async () => {
    const app = buildTestApp({ asUser: userStub });
    const { status } = await getJson(app, `/support/tickets/${randomUUID()}`);
    expect(status).toBe(404);
  });
});

// ─── Reply flow ───────────────────────────────────────────────────────────────

describe('POST /support/tickets/:id/reply', () => {
  it('user can reply on their own open ticket', async () => {
    const app = buildTestApp({ asUser: userStub });
    const { json: created } = await createTicket(app, 'My ticket', 'Initial body text here.');

    const { status } = await postJson(app, `/support/tickets/${created.id}/reply`, {
      body: 'Follow-up from user.',
    });
    expect(status).toBe(201);
  });

  it('reply from non-owner non-admin is 403', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const otherApp = buildTestApp({ asUser: otherUserStub });

    const { json: created } = await createTicket(userApp, 'My ticket', 'Initial body text here.');
    const { status } = await postJson(otherApp, `/support/tickets/${created.id}/reply`, {
      body: 'Sneaky reply.',
    });
    expect(status).toBe(403);
  });

  it('user reply on answered ticket sets status back to open', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    const { json: created } = await createTicket(
      userApp,
      'Status ticket',
      'Initial body text here.',
    );

    await postJson(adminApp, `/admin/support/tickets/${created.id}/reply`, {
      body: 'Admin response.',
    });

    await postJson(userApp, `/support/tickets/${created.id}/reply`, {
      body: 'User follow-up.',
    });

    const { json } = await getJson<{ status: string }>(userApp, `/support/tickets/${created.id}`);
    expect(json.status).toBe('open');
  });
});

// ─── Closed ticket blocks replies ─────────────────────────────────────────────

describe('closed ticket', () => {
  it('409 when user tries to reply on a closed ticket', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    const { json: created } = await createTicket(
      userApp,
      'To be closed',
      'Initial body text here.',
    );

    await postJson(adminApp, `/admin/support/tickets/${created.id}/close`);

    const { status, json } = await postJson<{ error: string }>(
      userApp,
      `/support/tickets/${created.id}/reply`,
      { body: 'Reply after close.' },
    );
    expect(status).toBe(409);
    expect(json.error).toBe('ticket_closed');
  });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

describe('admin support endpoints', () => {
  it('non-admin gets 403 on GET /admin/support/tickets', async () => {
    const app = buildTestApp({ asUser: userStub });
    const { status } = await getJson(app, '/admin/support/tickets');
    expect(status).toBe(403);
  });

  it('anonymous gets 401 on GET /admin/support/tickets', async () => {
    const app = buildTestApp();
    const { status } = await getJson(app, '/admin/support/tickets');
    expect(status).toBe(401);
  });

  it('admin can list all tickets', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    await createTicket(userApp, 'Ticket A', 'Body text long enough to pass validation check.');
    await createTicket(userApp, 'Ticket B', 'Body text long enough to pass validation check.');

    const { status, json } = await getJson<{ items: unknown[]; total: number }>(
      adminApp,
      '/admin/support/tickets',
    );
    expect(status).toBe(200);
    expect(json.total).toBeGreaterThanOrEqual(2);
  });

  it('admin can filter by status', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    const { json: created } = await createTicket(
      userApp,
      'Status filter',
      'Body text long enough here.',
    );
    await postJson(adminApp, `/admin/support/tickets/${created.id}/close`);

    const { json } = await getJson<{ items: Array<{ status: string }>; total: number }>(
      adminApp,
      '/admin/support/tickets?status=closed',
    );
    expect(json.total).toBeGreaterThanOrEqual(1);
    expect(json.items.every((t) => t.status === 'closed')).toBe(true);
  });

  it('admin reply sets status to answered', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    const { json: created } = await createTicket(
      userApp,
      'Admin reply test',
      'Body text long enough here.',
    );

    const { status } = await postJson(adminApp, `/admin/support/tickets/${created.id}/reply`, {
      body: 'Admin says hello.',
    });
    expect(status).toBe(201);

    const { json } = await getJson<{ status: string }>(userApp, `/support/tickets/${created.id}`);
    expect(json.status).toBe('answered');
  });

  it('admin can close a ticket', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    const { json: created } = await createTicket(
      userApp,
      'Close me',
      'Body text long enough here.',
    );

    const { status, json } = await postJson<{ id: string; status: string }>(
      adminApp,
      `/admin/support/tickets/${created.id}/close`,
    );
    expect(status).toBe(200);
    expect(json.status).toBe('closed');
  });

  it('admin cannot reply on a closed ticket', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    const { json: created } = await createTicket(
      userApp,
      'Already closed',
      'Body text long enough here.',
    );
    await postJson(adminApp, `/admin/support/tickets/${created.id}/close`);

    const { status, json } = await postJson<{ error: string }>(
      adminApp,
      `/admin/support/tickets/${created.id}/reply`,
      { body: 'Too late.' },
    );
    expect(status).toBe(409);
    expect(json.error).toBe('ticket_closed');
  });

  it('admin can read any ticket via user endpoint', async () => {
    const userApp = buildTestApp({ asUser: userStub });
    const adminApp = buildTestApp({ asUser: adminStub });

    const { json: created } = await createTicket(
      userApp,
      'Admin reads all',
      'Body text long enough here.',
    );
    const { status } = await getJson(adminApp, `/support/tickets/${created.id}`);
    expect(status).toBe(200);
  });
});
