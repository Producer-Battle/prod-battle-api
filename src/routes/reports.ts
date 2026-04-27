// User-facing /reports endpoint and admin moderation queue.
//
//   POST  /reports                     authenticated, anyone can file
//   GET   /admin/reports               admin only, list (open by default)
//   PATCH /admin/reports/:id           admin only, resolve / dismiss / action

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports } from '../db/schema.js';

export const reportsRoutes = new OpenAPIHono();

const ErrorBody = z.object({ error: z.string(), message: z.string() });

const SubjectType = z.enum(['submission', 'profile', 'pack', 'genre']);
const Reason = z.enum([
  'copyright',
  'nsfw',
  'harassment',
  'hate',
  'spam',
  'impersonation',
  'low_quality',
  'other',
]);
const Status = z.enum(['open', 'actioned', 'dismissed']);

const ReportRow = z.object({
  id: z.string().uuid(),
  subjectType: SubjectType,
  subjectId: z.string().uuid(),
  reporterId: z.string().uuid().nullable(),
  reason: Reason,
  notes: z.string().nullable(),
  status: Status,
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
  reviewerNote: z.string().nullable(),
});

// ─── POST /reports ──────────────────────────────────────────────────────────

const submitBody = z.object({
  subjectType: SubjectType,
  subjectId: z.string().uuid(),
  reason: Reason,
  notes: z.string().max(1000).optional(),
});

const submitRoute = createRoute({
  method: 'post',
  path: '/reports',
  tags: ['reports'],
  summary: 'File a report against a submission, profile, pack, or genre',
  request: { body: { content: { 'application/json': { schema: submitBody } } } },
  responses: {
    201: {
      description: 'Filed',
      content: {
        'application/json': { schema: z.object({ id: z.string().uuid() }) },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

reportsRoutes.openapi(submitRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in to report.' }, 401);

  const body = c.req.valid('json');
  const [row] = await db()
    .insert(reports)
    .values({
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      reporterId: user.id,
      reason: body.reason,
      notes: body.notes ?? null,
    })
    .returning({ id: reports.id });
  if (!row) {
    return c.json({ error: 'unauthenticated', message: 'Insert failed.' }, 401);
  }
  return c.json({ id: row.id }, 201);
});

// ─── GET /admin/reports ─────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/admin/reports',
  tags: ['admin', 'reports'],
  summary: 'List reports for moderation',
  request: {
    query: z.object({
      status: Status.optional().default('open'),
    }),
  },
  responses: {
    200: {
      description: 'Reports',
      content: {
        'application/json': { schema: z.object({ items: z.array(ReportRow) }) },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    403: { description: 'Not an admin', content: { 'application/json': { schema: ErrorBody } } },
  },
});

reportsRoutes.openapi(listRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  if (user.role !== 'admin')
    return c.json({ error: 'forbidden', message: 'Admin role required.' }, 403);

  const { status } = c.req.valid('query');
  const rows = await db()
    .select()
    .from(reports)
    .where(eq(reports.status, status))
    .orderBy(desc(reports.createdAt))
    .limit(200);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        subjectType: r.subjectType as z.infer<typeof SubjectType>,
        subjectId: r.subjectId,
        reporterId: r.reporterId,
        reason: r.reason as z.infer<typeof Reason>,
        notes: r.notes,
        status: r.status as z.infer<typeof Status>,
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
        reviewerNote: r.reviewerNote,
      })),
    },
    200,
  );
});

// ─── PATCH /admin/reports/:id ───────────────────────────────────────────────

const resolveBody = z.object({
  status: z.enum(['actioned', 'dismissed']),
  reviewerNote: z.string().max(1000).optional(),
});

const resolveRoute = createRoute({
  method: 'patch',
  path: '/admin/reports/{id}',
  tags: ['admin', 'reports'],
  summary: 'Resolve a report (action taken or dismissed)',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: resolveBody } } },
  },
  responses: {
    200: {
      description: 'Resolved',
      content: {
        'application/json': { schema: z.object({ id: z.string().uuid(), status: Status }) },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    403: { description: 'Not an admin', content: { 'application/json': { schema: ErrorBody } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
  },
});

reportsRoutes.openapi(resolveRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  if (user.role !== 'admin')
    return c.json({ error: 'forbidden', message: 'Admin role required.' }, 403);

  const { id } = c.req.valid('param');
  const body = c.req.valid('json');

  const result = await db()
    .update(reports)
    .set({
      status: body.status,
      reviewedBy: user.id,
      reviewedAt: new Date(),
      reviewerNote: body.reviewerNote ?? null,
    })
    .where(and(eq(reports.id, id), eq(reports.status, 'open')))
    .returning({ id: reports.id, status: reports.status });

  const row = result[0];
  if (!row) return c.json({ error: 'not_found', message: 'Already resolved or missing.' }, 404);
  return c.json({ id: row.id, status: row.status as z.infer<typeof Status> }, 200);
});

// Stub to avoid unused-import lint. Drizzle's `sql` is used in seed; keep
// it imported here so future moderation queries (e.g., reporter-honor
// weighting) have it ready.
void sql;
