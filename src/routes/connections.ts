// Friend connections - mutual, approval-based. Distinct from one-way follows.
//   POST   /me/connections/:userId           send a request (or accept a
//                                             reciprocal pending one)
//   GET    /me/connections                    { friends, incoming, outgoing }
//   POST   /me/connections/:userId/respond    accept / decline an incoming req
//   DELETE /me/connections/:userId            unfriend or cancel a request

import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { db } from '../db/client.js';
import { notifyConnectionAccepted, notifyConnectionRequest } from '../mail/touchpoints.js';

export const connectionsRoutes = new OpenAPIHono();

type Guard =
  | { ok: true; userId: string; handle: string }
  | { ok: false; status: 401; body: { error: string; message: string } };
function requireUser(c: Context): Guard {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  return { ok: true, userId: user.id, handle: user.handle ?? '' };
}
const logErr = (w: string) => (e: unknown) => console.error(`[connections] ${w}`, e);

// Send a friend request (or accept a reciprocal pending one).
connectionsRoutes.post('/me/connections/:userId', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const target = c.req.param('userId');
  if (target === g.userId)
    return c.json({ error: 'bad_request', message: "can't add yourself" }, 400);
  const d = db();

  const [tu] = await d.execute<{ id: string; handle: string }>(
    sql`SELECT id, handle FROM users WHERE id = ${target} AND status = 'active' LIMIT 1`,
  );
  if (!tu) return c.json({ error: 'not_found', message: 'User not found.' }, 404);

  // Any existing edge in either direction?
  const [edge] = await d.execute<{
    requester_id: string;
    addressee_id: string;
    status: string;
  }>(sql`
    SELECT requester_id, addressee_id, status FROM connections
     WHERE (requester_id = ${g.userId} AND addressee_id = ${target})
        OR (requester_id = ${target} AND addressee_id = ${g.userId})
     LIMIT 1
  `);

  if (edge) {
    if (edge.status === 'accepted') return c.json({ status: 'accepted' }, 200);
    // A pending request FROM the target TO me -> accept it (mutual intent).
    if (edge.status === 'pending' && edge.requester_id === target) {
      await d.execute(sql`
        UPDATE connections SET status = 'accepted', responded_at = now()
         WHERE requester_id = ${target} AND addressee_id = ${g.userId}
      `);
      void notifyConnectionAccepted(target, g.handle).catch(logErr('accepted'));
      return c.json({ status: 'accepted' }, 200);
    }
    // My own pending request already exists, or a declined edge - resend/pending.
    await d.execute(sql`
      INSERT INTO connections (requester_id, addressee_id, status, created_at)
      VALUES (${g.userId}, ${target}, 'pending', now())
      ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = 'pending', responded_at = NULL
    `);
    return c.json({ status: 'pending' }, 200);
  }

  await d.execute(sql`
    INSERT INTO connections (requester_id, addressee_id, status, created_at)
    VALUES (${g.userId}, ${target}, 'pending', now())
  `);
  void notifyConnectionRequest(target, g.handle).catch(logErr('request'));
  return c.json({ status: 'pending' }, 200);
});

connectionsRoutes.get('/me/connections', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const d = db();
  const me = g.userId;

  const friends = await d.execute<{
    user_id: string;
    handle: string;
    avatar_url: string | null;
  }>(sql`
    SELECT (CASE WHEN c.requester_id = ${me} THEN c.addressee_id ELSE c.requester_id END) AS user_id,
           u.handle, u.avatar_url
      FROM connections c
      JOIN users u ON u.id = (CASE WHEN c.requester_id = ${me} THEN c.addressee_id ELSE c.requester_id END)
     WHERE (c.requester_id = ${me} OR c.addressee_id = ${me}) AND c.status = 'accepted'
     ORDER BY c.responded_at DESC NULLS LAST
  `);
  const incoming = await d.execute<{
    user_id: string;
    handle: string;
    avatar_url: string | null;
    created_at: string;
  }>(sql`
    SELECT c.requester_id AS user_id, u.handle, u.avatar_url, c.created_at
      FROM connections c JOIN users u ON u.id = c.requester_id
     WHERE c.addressee_id = ${me} AND c.status = 'pending'
     ORDER BY c.created_at DESC
  `);
  const outgoing = await d.execute<{
    user_id: string;
    handle: string;
    avatar_url: string | null;
    created_at: string;
  }>(sql`
    SELECT c.addressee_id AS user_id, u.handle, u.avatar_url, c.created_at
      FROM connections c JOIN users u ON u.id = c.addressee_id
     WHERE c.requester_id = ${me} AND c.status = 'pending'
     ORDER BY c.created_at DESC
  `);

  return c.json(
    {
      friends: friends.map((r) => ({
        userId: r.user_id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
      })),
      incoming: incoming.map((r) => ({
        userId: r.user_id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      outgoing: outgoing.map((r) => ({
        userId: r.user_id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

connectionsRoutes.post('/me/connections/:userId/respond', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const requester = c.req.param('userId');
  const body = (await c.req.json().catch(() => ({}))) as { accept?: boolean };
  const accept = Boolean(body.accept);
  const d = db();
  const [edge] = await d.execute<{ status: string }>(sql`
    SELECT status FROM connections WHERE requester_id = ${requester} AND addressee_id = ${g.userId} LIMIT 1
  `);
  if (!edge) return c.json({ error: 'not_found', message: 'No request from this user.' }, 404);
  if (edge.status !== 'pending')
    return c.json({ error: 'done', message: 'Already responded.' }, 409);
  await d.execute(sql`
    UPDATE connections SET status = ${accept ? 'accepted' : 'declined'}, responded_at = now()
     WHERE requester_id = ${requester} AND addressee_id = ${g.userId}
  `);
  if (accept) void notifyConnectionAccepted(requester, g.handle).catch(logErr('accepted'));
  return c.json({ status: accept ? 'accepted' : 'declined' }, 200);
});

connectionsRoutes.delete('/me/connections/:userId', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const other = c.req.param('userId');
  await db().execute(sql`
    DELETE FROM connections
     WHERE (requester_id = ${g.userId} AND addressee_id = ${other})
        OR (requester_id = ${other} AND addressee_id = ${g.userId})
  `);
  return c.json({ removed: true }, 200);
});

// Status of the connection between me and one user (for profile buttons).
connectionsRoutes.get('/me/connections/:userId/status', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const other = c.req.param('userId');
  const [edge] = await db().execute<{ requester_id: string; status: string }>(sql`
    SELECT requester_id, status FROM connections
     WHERE (requester_id = ${g.userId} AND addressee_id = ${other})
        OR (requester_id = ${other} AND addressee_id = ${g.userId})
     LIMIT 1
  `);
  if (!edge) return c.json({ state: 'none' }, 200);
  if (edge.status === 'accepted') return c.json({ state: 'friends' }, 200);
  if (edge.status === 'declined') return c.json({ state: 'none' }, 200);
  return c.json({ state: edge.requester_id === g.userId ? 'outgoing' : 'incoming' }, 200);
});
