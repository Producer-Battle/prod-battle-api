// Integration test: the friend-connections flow (request -> accept -> friends)
// through real better-auth sessions, exercising the actual auth + middleware +
// handler chain. Mirrors tournament-register.test.ts. Run with the test DB.

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { auth } from '../../auth/config.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { anonId } from '../../middleware/anon-id.js';
import { attachSession } from '../../middleware/session.js';
import { registerRoutes } from '../../routes/index.js';
import { seedTestFixtures } from '../seed.js';

function buildAuthApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.all('/auth/*', (c) => auth.handler(c.req.raw));
  app.use('*', attachSession());
  app.use('*', anonId());
  registerRoutes(app);
  return app;
}

type TestUser = { id: string; handle: string; cookie: string };

async function makeUser(app: OpenAPIHono, tag: string): Promise<TestUser> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${tag}-${stamp}@test.local`;
  const password = 'connectiontest12345';
  const name = `${tag}${stamp}`.slice(0, 18);

  const su = await app.request('/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (su.status >= 300) throw new Error(`signup failed: ${su.status} ${await su.text()}`);
  await db().update(users).set({ emailVerified: true }).where(eq(users.email, email));

  const si = await app.request('/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = si.headers.get('set-cookie') ?? '';
  const cookie = setCookie
    .split(',')
    .map((p) => p.trim().split(';')[0] ?? '')
    .filter((p) => p.includes('='))
    .join('; ');

  const [u] = await db()
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!u) throw new Error('user not found after signup');
  return { id: u.id, handle: u.handle, cookie };
}

describe('friend connections', () => {
  let app: OpenAPIHono;
  beforeAll(async () => {
    app = buildAuthApp();
    await seedTestFixtures();
  });

  it('request -> accept makes both users friends', async () => {
    const a = await makeUser(app, 'amy');
    const b = await makeUser(app, 'ben');

    // A sends a request to B.
    const send = await app.request(`/me/connections/${b.id}`, {
      method: 'POST',
      headers: { cookie: a.cookie },
    });
    expect(send.status).toBe(200);
    expect(((await send.json()) as { status: string }).status).toBe('pending');

    // B sees it as incoming.
    const bList = await app.request('/me/connections', { headers: { cookie: b.cookie } });
    const bConns = (await bList.json()) as { incoming: { userId: string }[] };
    expect(bConns.incoming.some((x) => x.userId === a.id)).toBe(true);

    // B accepts.
    const resp = await app.request(`/me/connections/${a.id}/respond`, {
      method: 'POST',
      headers: { cookie: b.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    });
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { status: string }).status).toBe('accepted');

    // Both now list the other as a friend.
    const aList = await app.request('/me/connections', { headers: { cookie: a.cookie } });
    const aConns = (await aList.json()) as { friends: { userId: string }[] };
    expect(aConns.friends.some((x) => x.userId === b.id)).toBe(true);

    // Status endpoint reflects the friendship.
    const st = await app.request(`/me/connections/${b.id}/status`, {
      headers: { cookie: a.cookie },
    });
    expect(((await st.json()) as { state: string }).state).toBe('friends');
  });

  it('declining a request leaves no friendship', async () => {
    const a = await makeUser(app, 'cam');
    const b = await makeUser(app, 'dee');
    await app.request(`/me/connections/${b.id}`, { method: 'POST', headers: { cookie: a.cookie } });
    const resp = await app.request(`/me/connections/${a.id}/respond`, {
      method: 'POST',
      headers: { cookie: b.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: false }),
    });
    expect(((await resp.json()) as { status: string }).status).toBe('declined');
    const st = await app.request(`/me/connections/${b.id}/status`, {
      headers: { cookie: a.cookie },
    });
    expect(((await st.json()) as { state: string }).state).toBe('none');
  });

  it('rejects unauthenticated access', async () => {
    const res = await app.request('/me/connections');
    expect(res.status).toBe(401);
  });
});
