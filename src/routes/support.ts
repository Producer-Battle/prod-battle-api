// Support ticket routes for authenticated users.
//
// POST /support/tickets           - create a ticket (quota: 4/day)
// GET  /support/tickets           - list my tickets
// GET  /support/tickets/:id       - get ticket + replies
// POST /support/tickets/:id/reply - add a reply (closed tickets reject)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportTicketReplies, supportTickets } from '../db/schema.js';

export const supportRoutes = new OpenAPIHono();

const Err = z.object({ error: z.string(), message: z.string() });

const TICKET_DAILY_LIMIT = 4;

type Ctx = Parameters<Parameters<typeof supportRoutes.openapi>[1]>[0];

function requireUser(c: Ctx) {
  const user = c.var.user;
  if (!user)
    return {
      ok: false as const,
      status: 401 as const,
      body: { error: 'unauthenticated', message: 'Sign in to continue.' },
    };
  return { ok: true as const, user };
}

const TicketSummary = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  status: z.enum(['open', 'answered', 'closed']),
  replyCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ReplyItem = z.object({
  id: z.string().uuid(),
  authorHandle: z.string().nullable(),
  authorRole: z.enum(['user', 'admin']),
  body: z.string(),
  createdAt: z.string().datetime(),
});

const TicketDetail = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  status: z.enum(['open', 'answered', 'closed']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  replies: z.array(ReplyItem),
});

// ─── POST /support/tickets ────────────────────────────────────────────────────

const createTicketRoute = createRoute({
  method: 'post',
  path: '/support/tickets',
  tags: ['support'],
  summary: 'Create a support ticket',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            subject: z.string().min(3).max(120),
            body: z.string().min(10).max(4000),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Created',
      content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: Err } } },
    429: {
      description: 'Quota exhausted',
      content: { 'application/json': { schema: Err } },
    },
  },
});

supportRoutes.openapi(createTicketRoute, async (c) => {
  const auth = requireUser(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const { user } = auth;

  const d = db();

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [quotaRow] = await d
    .select({ n: count() })
    .from(supportTickets)
    .where(and(eq(supportTickets.userId, user.id), gte(supportTickets.createdAt, startOfDay)));

  if ((quotaRow?.n ?? 0) >= TICKET_DAILY_LIMIT) {
    return c.json(
      {
        error: 'ticket_quota_exhausted',
        message: `You can open at most ${TICKET_DAILY_LIMIT} tickets per day. Try again tomorrow.`,
      },
      429,
    );
  }

  const { subject, body } = c.req.valid('json');

  const [ticket] = await d
    .insert(supportTickets)
    .values({ userId: user.id, subject })
    .returning({ id: supportTickets.id });

  if (!ticket) return c.json({ error: 'create_failed', message: 'Could not create ticket.' }, 429);

  await d.insert(supportTicketReplies).values({
    ticketId: ticket.id,
    authorId: user.id,
    authorRole: 'user',
    body,
  });

  return c.json({ id: ticket.id }, 201);
});

// ─── GET /support/tickets ─────────────────────────────────────────────────────

const listMyTicketsRoute = createRoute({
  method: 'get',
  path: '/support/tickets',
  tags: ['support'],
  summary: 'List my support tickets',
  responses: {
    200: {
      description: 'Tickets',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(TicketSummary),
            quotaRemaining: z.number().int(),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: Err } } },
  },
});

supportRoutes.openapi(listMyTicketsRoute, async (c) => {
  const auth = requireUser(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const { user } = auth;

  const d = db();

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const rows = await d.execute<{
    id: string;
    subject: string;
    status: 'open' | 'answered' | 'closed';
    reply_count: string;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT
      t.id,
      t.subject,
      t.status,
      COUNT(r.id)::text AS reply_count,
      t.created_at,
      t.updated_at
    FROM support_tickets t
    LEFT JOIN support_ticket_replies r ON r.ticket_id = t.id
    WHERE t.user_id = ${user.id}
    GROUP BY t.id
    ORDER BY t.updated_at DESC
  `);

  const [quotaRow] = await d
    .select({ n: count() })
    .from(supportTickets)
    .where(and(eq(supportTickets.userId, user.id), gte(supportTickets.createdAt, startOfDay)));

  const usedToday = quotaRow?.n ?? 0;

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        replyCount: Number(r.reply_count),
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      quotaRemaining: Math.max(0, TICKET_DAILY_LIMIT - usedToday),
    },
    200,
  );
});

// ─── GET /support/tickets/:id ─────────────────────────────────────────────────

const getTicketRoute = createRoute({
  method: 'get',
  path: '/support/tickets/{id}',
  tags: ['support'],
  summary: 'Get ticket detail with replies',
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Ticket detail',
      content: { 'application/json': { schema: TicketDetail } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: Err } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: Err } } },
    404: { description: 'Not found', content: { 'application/json': { schema: Err } } },
  },
});

supportRoutes.openapi(getTicketRoute, async (c) => {
  const auth = requireUser(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const { user } = auth;

  const { id } = c.req.valid('param');
  const d = db();

  const [ticket] = await d
    .select({
      id: supportTickets.id,
      userId: supportTickets.userId,
      subject: supportTickets.subject,
      status: supportTickets.status,
      createdAt: supportTickets.createdAt,
      updatedAt: supportTickets.updatedAt,
    })
    .from(supportTickets)
    .where(eq(supportTickets.id, id))
    .limit(1);

  if (!ticket) return c.json({ error: 'not_found', message: 'No such ticket.' }, 404);

  if (ticket.userId !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden', message: 'Not your ticket.' }, 403);
  }

  const replies = await d.execute<{
    id: string;
    author_handle: string | null;
    author_role: 'user' | 'admin';
    body: string;
    created_at: string;
  }>(sql`
    SELECT
      r.id,
      u.handle AS author_handle,
      r.author_role,
      r.body,
      r.created_at
    FROM support_ticket_replies r
    JOIN users u ON u.id = r.author_id
    WHERE r.ticket_id = ${id}
    ORDER BY r.created_at ASC
  `);

  return c.json(
    {
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      replies: replies.map((r) => ({
        id: r.id,
        authorHandle: r.author_handle,
        authorRole: r.author_role,
        body: r.body,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

// ─── POST /support/tickets/:id/reply ─────────────────────────────────────────

const replyTicketRoute = createRoute({
  method: 'post',
  path: '/support/tickets/{id}/reply',
  tags: ['support'],
  summary: 'Reply to a ticket',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ body: z.string().min(1).max(4000) }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Reply created',
      content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: Err } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: Err } } },
    404: { description: 'Not found', content: { 'application/json': { schema: Err } } },
    409: {
      description: 'Ticket is closed',
      content: { 'application/json': { schema: Err } },
    },
  },
});

supportRoutes.openapi(replyTicketRoute, async (c) => {
  const auth = requireUser(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const { user } = auth;

  const { id } = c.req.valid('param');
  const { body } = c.req.valid('json');
  const d = db();

  const [ticket] = await d
    .select({
      id: supportTickets.id,
      userId: supportTickets.userId,
      status: supportTickets.status,
    })
    .from(supportTickets)
    .where(eq(supportTickets.id, id))
    .limit(1);

  if (!ticket) return c.json({ error: 'not_found', message: 'No such ticket.' }, 404);

  if (ticket.userId !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden', message: 'Not your ticket.' }, 403);
  }

  if (ticket.status === 'closed') {
    return c.json({ error: 'ticket_closed', message: 'This ticket is closed.' }, 409);
  }

  const authorRole = user.role === 'admin' ? ('admin' as const) : ('user' as const);

  const [reply] = await d
    .insert(supportTicketReplies)
    .values({ ticketId: id, authorId: user.id, authorRole, body })
    .returning({ id: supportTicketReplies.id });

  if (!reply) return c.json({ error: 'create_failed', message: 'Could not create reply.' }, 409);

  const newStatus = authorRole === 'admin' ? ('answered' as const) : ('open' as const);
  await d
    .update(supportTickets)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(supportTickets.id, id));

  return c.json({ id: reply.id }, 201);
});
