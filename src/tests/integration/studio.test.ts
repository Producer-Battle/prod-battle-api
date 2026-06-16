// Integration test: community Sample Flip submission -> hidden until reviewed
// -> A&R approves -> active + votable. Mirrors connections.test.ts harness.

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

async function makeUser(app: OpenAPIHono, tag: string, role?: 'ar'): Promise<TestUser> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${tag}-${stamp}@test.local`;
  const password = 'studiotest12345';
  const name = `${tag}${stamp}`.slice(0, 18);

  const su = await app.request('/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (su.status >= 300) throw new Error(`signup failed: ${su.status} ${await su.text()}`);
  await db()
    .update(users)
    .set({ emailVerified: true, ...(role ? { role } : {}) })
    .where(eq(users.email, email));

  const si = await app.request('/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (si.headers.get('set-cookie') ?? '')
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

describe('studio: sample-flip submission + review', () => {
  let app: OpenAPIHono;
  beforeAll(async () => {
    app = buildAuthApp();
    await seedTestFixtures();
  });

  it('submission is hidden until an A&R approves it, then votable', async () => {
    const producer = await makeUser(app, 'flipper');
    const scout = await makeUser(app, 'scout', 'ar');

    // Submit a flip loop.
    const submit = await app.request('/flip-sources', {
      method: 'POST',
      headers: { cookie: producer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Test Loop', url: 'https://example.com/loop.wav' }),
    });
    expect(submit.status).toBe(201);
    const { id } = (await submit.json()) as { id: string };

    // Not visible in the public active list yet.
    const before = await app.request('/flip-sources', { headers: { cookie: producer.cookie } });
    const beforeItems = ((await before.json()) as { items: { id: string }[] }).items;
    expect(beforeItems.some((i) => i.id === id)).toBe(false);

    // Shows in the A&R review queue.
    const queue = await app.request('/review/queue', { headers: { cookie: scout.cookie } });
    expect(queue.status).toBe(200);
    const flips = ((await queue.json()) as { flips: { id: string }[] }).flips;
    expect(flips.some((f) => f.id === id)).toBe(true);

    // A producer cannot reach the review queue.
    const forbidden = await app.request('/review/queue', { headers: { cookie: producer.cookie } });
    expect(forbidden.status).toBe(403);

    // A&R approves it.
    const approve = await app.request(`/review/flip-sources/${id}`, {
      method: 'POST',
      headers: { cookie: scout.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    });
    expect(approve.status).toBe(200);

    // Now visible in the active list.
    const after = await app.request('/flip-sources', { headers: { cookie: producer.cookie } });
    const afterItems = ((await after.json()) as { items: { id: string }[] }).items;
    expect(afterItems.some((i) => i.id === id)).toBe(true);

    // Community vote registers.
    const vote = await app.request(`/flip-sources/${id}/vote`, {
      method: 'POST',
      headers: { cookie: producer.cookie, 'content-type': 'application/json' },
    });
    expect(vote.status).toBe(200);
    expect(((await vote.json()) as { voteCount: number }).voteCount).toBe(1);
  });

  it('rejects unauthenticated submission', async () => {
    const res = await app.request('/flip-sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Anon Loop', url: 'https://example.com/x.wav' }),
    });
    expect(res.status).toBe(401);
  });
});
