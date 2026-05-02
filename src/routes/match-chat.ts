// Per-match room chat.
//
//   GET  /rooms/:code/chat        - last 50 messages (oldest -> newest)
//   POST /rooms/:code/chat        - send a message
//
// Free users get text-only: any unicode emoji in the body is stripped at
// the API boundary. Paid + admin users may emote freely. The plan check
// runs against the authenticated session; unauthenticated guests are not
// allowed to chat (silence beats abuse).
//
// Live broadcast piggybacks on the existing battle:{matchId} Redis channel
// so connected sockets see new messages without an extra subscribe.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { matchChat, matches, users } from '../db/schema.js';
import { requireAuth } from '../middleware/session.js';
import { publish } from '../realtime/pubsub.js';

export const matchChatRoutes = new OpenAPIHono();

const MAX_BODY = 280;
const MAX_MESSAGES = 50;
// Per-user-per-match send cooldown (ms). Soft anti-spam; replace with a
// real token-bucket if abuse becomes a thing.
const COOLDOWN_MS = 1500;
const recentSendAt = new Map<string, number>();

// Strip unicode emoji + variation selectors. Used for the free tier.
// Extended_Pictographic covers the Unicode emoji blocks; ZWJ/VS16 cleanup
// keeps remnants of compound emoji from leaving stray invisibles.
function stripEmoji(input: string): string {
  return input
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[‍️]/g, '')
    .trim();
}

function hasEmoji(input: string): boolean {
  return /\p{Extended_Pictographic}/u.test(input);
}

const ChatRow = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  handle: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
});

// ─── GET /rooms/:code/chat ────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/rooms/{code}/chat',
  tags: ['chat'],
  summary: 'Last 50 chat messages for the room',
  request: {
    params: z.object({ code: z.string() }),
    query: z.object({ after: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: 'Messages, oldest first',
      content: { 'application/json': { schema: z.object({ items: z.array(ChatRow) }) } },
    },
    404: { description: 'Match not found' },
  },
});

matchChatRoutes.openapi(listRoute, async (c) => {
  const { code } = c.req.valid('param');
  const { after } = c.req.valid('query');

  const d = db();
  const [match] = await d
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.roomCode, code));
  if (!match) return c.json({ error: 'match_not_found' }, 404);

  let cutoff: Date | null = null;
  if (after) {
    const [row] = await d
      .select({ createdAt: matchChat.createdAt })
      .from(matchChat)
      .where(eq(matchChat.id, after))
      .limit(1);
    cutoff = row?.createdAt ?? null;
  }

  const rows = await d
    .select({
      id: matchChat.id,
      userId: matchChat.userId,
      handle: matchChat.handleSnapshot,
      body: matchChat.body,
      createdAt: matchChat.createdAt,
    })
    .from(matchChat)
    .where(
      cutoff
        ? and(eq(matchChat.matchId, match.id), gt(matchChat.createdAt, cutoff))
        : eq(matchChat.matchId, match.id),
    )
    .orderBy(asc(matchChat.createdAt))
    .limit(MAX_MESSAGES);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        handle: r.handle,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    200,
  );
});

// ─── POST /rooms/:code/chat ───────────────────────────────────────────────────

const sendRoute = createRoute({
  method: 'post',
  path: '/rooms/{code}/chat',
  tags: ['chat'],
  summary: 'Send a chat message',
  middleware: [requireAuth()] as const,
  request: {
    params: z.object({ code: z.string() }),
    body: {
      content: {
        'application/json': { schema: z.object({ body: z.string().min(1).max(MAX_BODY) }) },
      },
    },
  },
  responses: {
    201: { description: 'Sent', content: { 'application/json': { schema: ChatRow } } },
    400: { description: 'Empty after emoji strip / too long' },
    401: { description: 'Unauthenticated' },
    404: { description: 'Match not found' },
    429: { description: 'Cooldown' },
  },
});

matchChatRoutes.openapi(sendRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const { code } = c.req.valid('param');
  const { body } = c.req.valid('json');

  const d = db();
  const [match] = await d
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.roomCode, code));
  if (!match) return c.json({ error: 'match_not_found' }, 404);

  // Per-user-per-match cooldown (in-memory; sufficient for one-replica
  // serverless container today, swap to Redis if we scale out).
  const cooldownKey = `${match.id}:${user.id}`;
  const lastAt = recentSendAt.get(cooldownKey) ?? 0;
  const now = Date.now();
  if (now - lastAt < COOLDOWN_MS) {
    return c.json({ error: 'cooldown', retryAfterMs: COOLDOWN_MS - (now - lastAt) }, 429);
  }

  const isPaid = user.plan === 'paid' || user.role === 'admin';
  // Apply emoji policy. Free users get the stripped version; paid/admin
  // pass through unchanged.
  const sanitized = isPaid ? body.trim() : hasEmoji(body) ? stripEmoji(body) : body.trim();
  if (sanitized.length === 0) {
    return c.json({ error: 'empty_after_strip', message: 'Free tier: text only.' }, 400);
  }

  // Snapshot the handle so a later rename doesn't retro-edit chat.
  const [u] = await d.select({ handle: users.handle }).from(users).where(eq(users.id, user.id));
  const handle = u?.handle ?? 'unknown';

  const [inserted] = await d
    .insert(matchChat)
    .values({
      matchId: match.id,
      userId: user.id,
      handleSnapshot: handle,
      body: sanitized,
    })
    .returning({ id: matchChat.id, createdAt: matchChat.createdAt });

  if (!inserted) {
    return c.json({ error: 'insert_failed' }, 500);
  }

  recentSendAt.set(cooldownKey, now);

  const payload = {
    id: inserted.id,
    userId: user.id,
    handle,
    body: sanitized,
    createdAt: inserted.createdAt.toISOString(),
  };

  // Live broadcast over the existing match channel so connected sockets
  // get it without a separate subscribe.
  await publish(`battle:${match.id}`, { type: 'chat', message: payload });

  // Opportunistic prune: keep table light - if we exceed 200 rows for this
  // match, delete the oldest. Cheap (single index lookup).
  await d.execute(
    sql`DELETE FROM match_chat
         WHERE match_id = ${match.id}
           AND id IN (
             SELECT id FROM match_chat
              WHERE match_id = ${match.id}
              ORDER BY created_at DESC
              OFFSET 200
           )`,
  );

  return c.json(payload, 201);
});
