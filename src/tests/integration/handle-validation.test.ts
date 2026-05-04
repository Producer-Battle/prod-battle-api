// Integration tests for handle validation at sign-up and PATCH /me.
//
// Exercises the full better-auth signup path (real DB, real auth handler)
// to confirm that:
//   - email sign-up with an invalid handle (contains @, spaces, etc.) is rejected
//     with a 4xx and a user-facing error message.
//   - email sign-up with a valid handle succeeds.
//   - PATCH /me with handle="@toiletflusher" returns 400.
//   - PATCH /me with handle="toiletflusher" returns 200.
//
// Also tests the randomHandle() helper exported from auth/config.ts.

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HANDLE_RE, randomHandle } from '../../auth/config.js';
import { auth } from '../../auth/config.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { anonId } from '../../middleware/anon-id.js';
import type { AuthUser } from '../../middleware/session.js';
import { attachSession } from '../../middleware/session.js';
import { registerRoutes } from '../../routes/index.js';

// ─── App builders ─────────────────────────────────────────────────────────────

function buildAuthApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.all('/auth/*', (c) => auth.handler(c.req.raw));
  app.use('*', attachSession());
  app.use('*', anonId());
  registerRoutes(app);
  return app;
}

function buildAppAsUser(user: AuthUser): OpenAPIHono {
  const app = new OpenAPIHono();
  app.use('*', anonId());
  app.use(
    '*',
    createMiddleware(async (c, next) => {
      c.set('user', user);
      await next();
    }),
  );
  registerRoutes(app);
  return app;
}

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

async function deleteUserByEmail(email: string): Promise<void> {
  try {
    await db().delete(users).where(eq(users.email, email));
  } catch {
    // Ignore - may not exist if test failed before creation.
  }
}

// ─── Unit tests for exported helpers ──────────────────────────────────────────

describe('HANDLE_RE', () => {
  it('accepts valid handles', () => {
    for (const h of [
      'abc',
      'toiletflusher',
      'my-handle',
      'user_123',
      'A1B2C3',
      '12345678901234567890',
    ]) {
      expect(HANDLE_RE.test(h), `expected "${h}" to be valid`).toBe(true);
    }
  });

  it('rejects handles with @', () => {
    expect(HANDLE_RE.test('@bram')).toBe(false);
    expect(HANDLE_RE.test('bram@test')).toBe(false);
  });

  it('rejects handles with spaces', () => {
    expect(HANDLE_RE.test('my handle')).toBe(false);
    expect(HANDLE_RE.test(' handle')).toBe(false);
  });

  it('rejects handles shorter than 3 characters', () => {
    expect(HANDLE_RE.test('ab')).toBe(false);
    expect(HANDLE_RE.test('a')).toBe(false);
    expect(HANDLE_RE.test('')).toBe(false);
  });

  it('rejects handles longer than 20 characters', () => {
    expect(HANDLE_RE.test('a'.repeat(21))).toBe(false);
  });
});

describe('randomHandle()', () => {
  it('generates handles that match HANDLE_RE', () => {
    for (let i = 0; i < 20; i++) {
      const h = randomHandle();
      expect(HANDLE_RE.test(h), `randomHandle() returned invalid handle: "${h}"`).toBe(true);
    }
  });

  it('generates handles with the phonky-stoat-NNN pattern', () => {
    const h = randomHandle();
    // Pattern: adjective-noun-NNN where NNN is 100-999
    expect(h).toMatch(/^[a-z]+-[a-z0-9]+-\d{3}$/);
  });
});

// ─── Sign-up validation (integration - requires real DB + auth) ───────────────

describe('sign-up handle validation (integration)', () => {
  let app: OpenAPIHono;
  const createdEmails: string[] = [];

  beforeAll(() => {
    app = buildAuthApp();
  });

  afterEach(async () => {
    for (const email of createdEmails) {
      await deleteUserByEmail(email);
    }
    createdEmails.length = 0;
  });

  it('POST /auth/sign-up/email with name="@bram" returns 4xx with handle error', async () => {
    const email = `handle-val-bad-${Date.now()}@test.local`;
    createdEmails.push(email);

    const res = await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'testpass123', name: '@bram' }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // The error body should mention the handle requirement.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(body?.message ?? body?.error ?? '').toLowerCase();
    expect(message).toMatch(/handle|character|letter/i);
  });

  it('POST /auth/sign-up/email with name="at space handle" returns 4xx', async () => {
    const email = `handle-val-space-${Date.now()}@test.local`;
    createdEmails.push(email);

    const res = await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'testpass123', name: 'my bad handle' }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('POST /auth/sign-up/email with name="bram" (valid) succeeds with 2xx', async () => {
    const email = `handle-val-ok-${Date.now()}@test.local`;
    createdEmails.push(email);
    // Use a unique handle to avoid collisions.
    const handle = `bramtest${Date.now().toString(36)}`;

    const res = await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'testpass123', name: handle }),
    });

    // 200 (dev / no email verification) or 201 (accepted + pending verification).
    // Better-auth may also return 200 with token=null when verification is required.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});

// ─── PATCH /me handle validation ─────────────────────────────────────────────

describe('PATCH /me handle validation (e2e with stub auth)', () => {
  it('PATCH /me with handle="@toiletflusher" returns 400', async () => {
    // Insert a real user row so the handler can look it up.
    const email = `patch-handle-bad-${Date.now()}@test.local`;
    const handle = `patchbad${Date.now().toString(36)}`;
    const [row] = await db()
      .insert(users)
      .values({ handle, email, emailVerified: true })
      .returning();
    if (!row) throw new Error('seed failed');

    const user: AuthUser = {
      id: row.id,
      handle: row.handle,
      email: row.email,
      role: 'producer',
      plan: 'free',
      status: 'active',
    };
    const app = buildAppAsUser(user);

    const res = await app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: '@toiletflusher' }),
    });

    expect(res.status).toBe(400);

    // Cleanup.
    await db().delete(users).where(eq(users.id, row.id));
  });

  it('PATCH /me with handle="toiletflusher" returns 200', async () => {
    const email = `patch-handle-ok-${Date.now()}@test.local`;
    const handle = `patchok${Date.now().toString(36)}`;
    const [row] = await db()
      .insert(users)
      .values({ handle, email, emailVerified: true })
      .returning();
    if (!row) throw new Error('seed failed');

    const user: AuthUser = {
      id: row.id,
      handle: row.handle,
      email: row.email,
      role: 'producer',
      plan: 'free',
      status: 'active',
    };
    const app = buildAppAsUser(user);

    // Use a unique target handle to avoid collisions with other test runs.
    const newHandle = `toilet${Date.now().toString(36)}`;
    const res = await app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: newHandle }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { handle: string };
    expect(body.handle).toBe(newHandle.toLowerCase());

    // Cleanup.
    await db().delete(users).where(eq(users.id, row.id));
  });
});
