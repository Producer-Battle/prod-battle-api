// Integration test: drives POST /tournaments/{id}/register through a real
// better-auth session (cookie) instead of the asUser-mocked harness path.
//
// User reported a 500 in prod when registering as a logged-in admin. The
// existing tournament-bracket e2e mocked the session, so it never exercised
// the actual auth/middleware/handler chain - this test does. Run with the
// test DB; no mailpit dependency (we flip email_verified directly).

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auth } from '../../auth/config.js';
import { db } from '../../db/client.js';
import { genres, tournaments, users } from '../../db/schema.js';
import { anonId } from '../../middleware/anon-id.js';
import { attachSession } from '../../middleware/session.js';
import { registerRoutes } from '../../routes/index.js';
import { resetMatchState, seedTestFixtures } from '../seed.js';

function buildAuthApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.all('/auth/*', (c) => auth.handler(c.req.raw));
  app.use('*', attachSession());
  app.use('*', anonId());
  registerRoutes(app);
  return app;
}

describe('POST /tournaments/{id}/register (real session)', () => {
  let app: OpenAPIHono;

  beforeAll(async () => {
    app = buildAuthApp();
    await seedTestFixtures();
    await resetMatchState();
    await seedTestFixtures();
  });

  it('returns 201 for a verified, signed-in user with sufficient honor', async () => {
    const stamp = Date.now();
    const email = `tnreg-${stamp}@test.local`;
    const password = 'registertest12345';
    const name = `tnreg${stamp}`;

    // 1. Sign up via better-auth (creates user, emailVerified=false).
    const signupRes = await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    expect(signupRes.status).toBeLessThan(300);

    // 2. Skip the email click - flip email_verified directly so signin works.
    await db().update(users).set({ emailVerified: true }).where(eq(users.email, email));

    // 3. Sign in to get the session cookie.
    const signinRes = await app.request('/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(signinRes.status).toBeLessThan(300);
    const setCookie = signinRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/pb_\.session_token=/i);
    const cookieHeader = setCookie
      .split(',')
      .map((p) => p.trim().split(';')[0] ?? '')
      .filter((p) => p.includes('='))
      .join('; ');

    // 4. Insert an open tournament directly.
    const [g] = await db().select({ id: genres.id }).from(genres).limit(1);
    if (!g) throw new Error('no genre seeded');
    const [t] = (await db().execute<{ id: string }>(
      sql`INSERT INTO tournaments
            (name, genre_id, starts_at, registration_closes_at, max_entrants,
             status, auto_created)
          VALUES
            ('repro', ${g.id},
             now() + interval '2 hours', now() + interval '1 hour',
             16, 'open', false)
          RETURNING id`,
    )) as Array<{ id: string }>;
    if (!t) throw new Error('failed to insert tournament');

    // 5. Hit the register endpoint with the session cookie. This is the
    // path that 500s in prod for @toiletflusher.
    const res = await app.request(`/tournaments/${t.id}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
      },
    });
    const body = await res.text();
    if (res.status !== 201) {
      // Log the full body so the test failure is informative.
      console.error('register failed', { status: res.status, body });
    }
    expect(res.status).toBe(201);
  });
});
