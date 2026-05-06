// Admin support-ticket management.
//
// GET  /admin/support/tickets          - list all tickets, filter by status
// POST /admin/support/tickets/:id/reply - admin reply
// POST /admin/support/tickets/:id/close - close a ticket

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportTicketReplies, supportTickets } from '../db/schema.js';

export const adminSupportRoutes = new OpenAPIHono();

const AdminErr = z.object({ error: z.string(), message: z.string() });

const requireAdmin = (
  c: Parameters<Parameters<typeof adminSupportRoutes.openapi>[1]>[0],
):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } } => {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'admin')
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'Admin role required.' },
    };
  return { ok: true, userId: user.id };
};

const TICKET_STATUSES = ['open', 'answered', 'closed'] as const;

const AdminTicketSummary = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  userHandle: z.string().nullable(),
  subject: z.string(),
  status: z.enum(TICKET_STATUSES),
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

// ─── GET /admin/support/tickets ───────────────────────────────────────────────

const listTicketsRoute = createRoute({
  method: 'get',
  path: '/admin/support/tickets',
  tags: ['admin'],
  summary: 'List all support tickets',
  request: {
    query: z.object({
      status: z.enum(TICKET_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      description: 'Tickets',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(AdminTicketSummary),
            total: z.number().int(),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: AdminErr } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminErr } } },
  },
});

adminSupportRoutes.openapi(listTicketsRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { status, limit, offset } = c.req.valid('query');
  const d = db();

  const rows = await d.execute<{
    id: string;
    user_id: string;
    user_handle: string | null;
    subject: string;
    status: 'open' | 'answered' | 'closed';
    reply_count: string;
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT
      t.id,
      t.user_id,
      u.handle AS user_handle,
      t.subject,
      t.status,
      COUNT(r.id)::text AS reply_count,
      t.created_at,
      t.updated_at
    FROM support_tickets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN support_ticket_replies r ON r.ticket_id = t.id
    WHERE (${status ?? null}::ticket_status IS NULL OR t.status = ${status ?? null}::ticket_status)
    GROUP BY t.id, u.handle
    ORDER BY t.updated_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  const [totalRow] = await d.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM support_tickets t
    WHERE (${status ?? null}::ticket_status IS NULL OR t.status = ${status ?? null}::ticket_status)
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        userHandle: r.user_handle,
        subject: r.subject,
        status: r.status,
        replyCount: Number(r.reply_count),
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      total: Number(totalRow?.n ?? 0),
    },
    200,
  );
});

// ─── GET /admin/support/tickets/:id ──────────────────────────────────────────

const getTicketRoute = createRoute({
  method: 'get',
  path: '/admin/support/tickets/{id}',
  tags: ['admin'],
  summary: 'Get ticket detail with replies',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Ticket detail',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string().uuid(),
            userId: z.string().uuid(),
            userHandle: z.string().nullable(),
            subject: z.string(),
            status: z.enum(TICKET_STATUSES),
            createdAt: z.string().datetime(),
            updatedAt: z.string().datetime(),
            replies: z.array(ReplyItem),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: AdminErr } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminErr } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminErr } } },
  },
});

adminSupportRoutes.openapi(getTicketRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  const ticketRows = await d.execute<{
    id: string;
    user_id: string;
    user_handle: string | null;
    subject: string;
    status: 'open' | 'answered' | 'closed';
    created_at: string;
    updated_at: string;
  }>(sql`
    SELECT t.id, t.user_id, u.handle AS user_handle, t.subject, t.status, t.created_at, t.updated_at
    FROM support_tickets t
    JOIN users u ON u.id = t.user_id
    WHERE t.id = ${id}
    LIMIT 1
  `);

  const ticket = ticketRows[0];
  if (!ticket) return c.json({ error: 'not_found', message: 'No such ticket.' }, 404);

  const replies = await d.execute<{
    id: string;
    author_handle: string | null;
    author_role: 'user' | 'admin';
    body: string;
    created_at: string;
  }>(sql`
    SELECT r.id, u.handle AS author_handle, r.author_role, r.body, r.created_at
    FROM support_ticket_replies r
    JOIN users u ON u.id = r.author_id
    WHERE r.ticket_id = ${id}
    ORDER BY r.created_at ASC
  `);

  return c.json(
    {
      id: ticket.id,
      userId: ticket.user_id,
      userHandle: ticket.user_handle,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: new Date(ticket.created_at).toISOString(),
      updatedAt: new Date(ticket.updated_at).toISOString(),
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

// ─── POST /admin/support/tickets/:id/reply ────────────────────────────────────

const adminReplyRoute = createRoute({
  method: 'post',
  path: '/admin/support/tickets/{id}/reply',
  tags: ['admin'],
  summary: 'Admin reply to a ticket',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': { schema: z.object({ body: z.string().min(1).max(4000) }) },
      },
    },
  },
  responses: {
    201: {
      description: 'Reply created',
      content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: AdminErr } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminErr } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminErr } } },
    409: {
      description: 'Ticket is closed',
      content: { 'application/json': { schema: AdminErr } },
    },
  },
});

adminSupportRoutes.openapi(adminReplyRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const { body } = c.req.valid('json');
  const d = db();

  const [ticket] = await d
    .select({ id: supportTickets.id, status: supportTickets.status })
    .from(supportTickets)
    .where(eq(supportTickets.id, id))
    .limit(1);

  if (!ticket) return c.json({ error: 'not_found', message: 'No such ticket.' }, 404);
  if (ticket.status === 'closed') {
    return c.json({ error: 'ticket_closed', message: 'This ticket is closed.' }, 409);
  }

  const [reply] = await d
    .insert(supportTicketReplies)
    .values({ ticketId: id, authorId: g.userId, authorRole: 'admin', body })
    .returning({ id: supportTicketReplies.id });

  if (!reply) return c.json({ error: 'create_failed', message: 'Could not create reply.' }, 409);

  await d
    .update(supportTickets)
    .set({ status: 'answered', updatedAt: new Date() })
    .where(eq(supportTickets.id, id));

  return c.json({ id: reply.id }, 201);
});

// ─── POST /admin/support/tickets/:id/close ────────────────────────────────────

const closeTicketRoute = createRoute({
  method: 'post',
  path: '/admin/support/tickets/{id}/close',
  tags: ['admin'],
  summary: 'Close a ticket',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Closed',
      content: {
        'application/json': {
          schema: z.object({ id: z.string().uuid(), status: z.literal('closed') }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: AdminErr } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminErr } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminErr } } },
  },
});

adminSupportRoutes.openapi(closeTicketRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  const [updated] = await d
    .update(supportTickets)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(supportTickets.id, id))
    .returning({ id: supportTickets.id });

  if (!updated) return c.json({ error: 'not_found', message: 'No such ticket.' }, 404);
  return c.json({ id: updated.id, status: 'closed' as const }, 200);
});
