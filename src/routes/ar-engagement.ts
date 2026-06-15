// A&R engagement layer endpoints (separate from the read-only /ar dashboard
// in ar.ts):
//   - A&R Picks: rate a track (separate signal, never changes battle results)
//   - Scouting feeds: /ar/drops, /ar/rising, /ar/watchlist/activity
//   - Reach-out: A&R -> producer contact requests + producer inbox
//   - A&R Briefs: label-posted challenges, producer entries, winner pick
//   - Most-Scouted leaderboard
//
// New endpoints use plain Hono handlers (less boilerplate than the OpenAPI
// route objects in ar.ts); auth comes from c.var.user (global ContextVariableMap).

import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import {
  notifyArBriefWinner,
  notifyArContactRequest,
  notifyArContactResponse,
  notifyArPick,
} from '../mail/touchpoints.js';

export const arEngagementRoutes = new OpenAPIHono();

type ArGuard =
  | { ok: true; userId: string; handle: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } };

function requireAr(c: Context): ArGuard {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'ar' && user.role !== 'admin')
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'A&R or admin role required.' },
    };
  return { ok: true, userId: user.id, handle: user.handle ?? 'an A&R' };
}

function requireUser(c: Context): ArGuard {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  return { ok: true, userId: user.id, handle: user.handle ?? '' };
}

const logErr = (where: string) => (e: unknown) => console.error(`[ar] ${where}`, e);

// ─── A&R Picks ───────────────────────────────────────────────────────────────

arEngagementRoutes.post('/ar/picks/:submissionId', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const submissionId = c.req.param('submissionId');
  const body = (await c.req.json().catch(() => ({}))) as {
    score?: number;
    note?: string;
    cosign?: boolean;
  };
  const score = Math.max(1, Math.min(5, Math.round(Number(body.score ?? 0))));
  if (!score) return c.json({ error: 'bad_request', message: 'score 1-5 required' }, 400);
  const note = body.note ? body.note.slice(0, 280) : null;
  const cosign = Boolean(body.cosign);
  const d = db();

  const [sub] = await d.execute<{ user_id: string }>(
    sql`SELECT user_id FROM submissions WHERE id = ${submissionId} LIMIT 1`,
  );
  if (!sub) return c.json({ error: 'not_found', message: 'Submission not found.' }, 404);

  const existing = await d.execute<{ score: number }>(
    sql`SELECT score FROM ar_picks WHERE ar_user_id = ${g.userId} AND submission_id = ${submissionId}`,
  );
  await d.execute(sql`
    INSERT INTO ar_picks (ar_user_id, submission_id, score, note, cosign, created_at)
    VALUES (${g.userId}, ${submissionId}, ${score}, ${note}, ${cosign}, now())
    ON CONFLICT (ar_user_id, submission_id)
      DO UPDATE SET score = EXCLUDED.score, note = EXCLUDED.note, cosign = EXCLUDED.cosign
  `);

  // Notify the producer only on a brand-new pick, and never on a self-pick.
  if (existing.length === 0 && sub.user_id !== g.userId) {
    void notifyArPick(sub.user_id, submissionId, g.handle, score, note).catch(
      logErr('notifyArPick'),
    );
  }
  return c.json({ submissionId, score, note, cosign }, 200);
});

arEngagementRoutes.delete('/ar/picks/:submissionId', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const submissionId = c.req.param('submissionId');
  await db().execute(
    sql`DELETE FROM ar_picks WHERE ar_user_id = ${g.userId} AND submission_id = ${submissionId}`,
  );
  return c.json({ removed: true }, 200);
});

arEngagementRoutes.get('/ar/picks', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const rows = await db().execute<{
    submission_id: string;
    score: number;
    note: string | null;
    cosign: boolean;
    created_at: string;
  }>(sql`
    SELECT submission_id, score, note, cosign, created_at
      FROM ar_picks WHERE ar_user_id = ${g.userId}
     ORDER BY created_at DESC LIMIT 100
  `);
  return c.json(
    {
      items: rows.map((r) => ({
        submissionId: r.submission_id,
        score: r.score,
        note: r.note,
        cosign: r.cosign,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

// ─── Scouting feeds ──────────────────────────────────────────────────────────

// Fresh standout tracks to scout, newest first, with A&R-pick context.
arEngagementRoutes.get('/ar/drops', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 30)));
  const genreSlug = c.req.query('genreSlug') ?? null;
  const d = db();
  const rows = await d.execute<{
    id: string;
    title: string | null;
    audio_url: string;
    score: string;
    final_rank: number | null;
    created_at: string;
    producer_id: string;
    handle: string;
    avatar_url: string | null;
    slug: string;
    name: string;
    ar_count: string;
    mine_score: number | null;
  }>(sql`
    SELECT s.id, s.title, s.audio_url, s.score::text AS score, s.final_rank, s.created_at,
           u.id AS producer_id, u.handle, u.avatar_url, g.slug, g.name,
           COALESCE(ap.cnt, 0)::text AS ar_count, mine.score AS mine_score
      FROM submissions s
      JOIN users u ON u.id = s.user_id
      JOIN genres g ON g.id = s.genre_id
      JOIN matches m ON m.id = s.match_id
      LEFT JOIN (SELECT submission_id, COUNT(*) AS cnt FROM ar_picks GROUP BY submission_id) ap
             ON ap.submission_id = s.id
      LEFT JOIN ar_picks mine ON mine.submission_id = s.id AND mine.ar_user_id = ${g.userId}
     WHERE s.is_public = true AND m.status = 'results'
       AND (${genreSlug}::text IS NULL OR g.slug = ${genreSlug})
     ORDER BY s.created_at DESC
     LIMIT ${limit}
  `);
  const items = await Promise.all(
    rows.map(async (r) => ({
      submissionId: r.id,
      title: r.title,
      audioUrl: await signUrl(r.audio_url),
      score: Number(r.score),
      finalRank: r.final_rank,
      createdAt: new Date(r.created_at).toISOString(),
      producer: { id: r.producer_id, handle: r.handle, avatarUrl: r.avatar_url },
      genre: { slug: r.slug, name: r.name },
      arPickCount: Number(r.ar_count),
      myPickScore: r.mine_score ?? null,
    })),
  );
  return c.json({ items }, 200);
});

// Producers with recent momentum (last 14 days).
arEngagementRoutes.get('/ar/rising', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
  const rows = await db().execute<{
    id: string;
    handle: string;
    avatar_url: string | null;
    recent_score: string;
    recent_wins: string;
    recent_matches: string;
  }>(sql`
    SELECT u.id, u.handle, u.avatar_url,
           COALESCE(SUM(s.score), 0)::text AS recent_score,
           COUNT(*) FILTER (WHERE s.final_rank = 1)::text AS recent_wins,
           COUNT(DISTINCT s.match_id)::text AS recent_matches
      FROM users u
      JOIN submissions s ON s.user_id = u.id
      JOIN matches m ON m.id = s.match_id
     WHERE u.role = 'producer' AND m.ended_at > now() - interval '14 days'
     GROUP BY u.id, u.handle, u.avatar_url
    HAVING COUNT(DISTINCT s.match_id) >= 1
     ORDER BY recent_wins DESC, recent_score DESC
     LIMIT ${limit}
  `);
  return c.json(
    {
      items: rows.map((r) => ({
        producerId: r.id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
        recentScore: Number(r.recent_score),
        recentWins: Number(r.recent_wins),
        recentMatches: Number(r.recent_matches),
      })),
    },
    200,
  );
});

// Recent activity by producers on the calling A&R's watchlist.
arEngagementRoutes.get('/ar/watchlist/activity', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const rows = await db().execute<{
    handle: string;
    producer_id: string;
    submission_id: string;
    title: string | null;
    final_rank: number | null;
    score: string;
    genre_name: string;
    created_at: string;
  }>(sql`
    SELECT u.handle, u.id AS producer_id, s.id AS submission_id, s.title, s.final_rank,
           s.score::text AS score, g.name AS genre_name, s.created_at
      FROM ar_watchlist w
      JOIN users u ON u.id = w.producer_id
      JOIN submissions s ON s.user_id = w.producer_id AND s.is_public = true
      JOIN genres g ON g.id = s.genre_id
     WHERE w.ar_user_id = ${g.userId} AND s.created_at > now() - interval '21 days'
     ORDER BY s.created_at DESC LIMIT 50
  `);
  return c.json(
    {
      items: rows.map((r) => ({
        producerId: r.producer_id,
        handle: r.handle,
        submissionId: r.submission_id,
        title: r.title,
        finalRank: r.final_rank,
        score: Number(r.score),
        genreName: r.genre_name,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

// ─── Reach-out ("a label is interested") ─────────────────────────────────────

arEngagementRoutes.post('/ar/contact/:producerId', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const producerId = c.req.param('producerId');
  const body = (await c.req.json().catch(() => ({}))) as { message?: string };
  const message = (body.message ?? '').trim().slice(0, 1000);
  if (!message) return c.json({ error: 'bad_request', message: 'message required' }, 400);
  if (producerId === g.userId)
    return c.json({ error: 'bad_request', message: "can't contact yourself" }, 400);
  const d = db();

  const [p] = await d.execute<{ open_to_ar: boolean }>(sql`
    SELECT COALESCE(pp.open_to_ar, true) AS open_to_ar
      FROM users u LEFT JOIN producer_profiles pp ON pp.user_id = u.id
     WHERE u.id = ${producerId} AND u.status = 'active' LIMIT 1
  `);
  if (!p) return c.json({ error: 'not_found', message: 'Producer not found.' }, 404);
  if (!p.open_to_ar)
    return c.json({ error: 'closed', message: 'This producer is not open to A&R.' }, 403);

  await d.execute(sql`
    INSERT INTO ar_contact_requests (ar_user_id, producer_id, message, status, created_at)
    VALUES (${g.userId}, ${producerId}, ${message}, 'pending', now())
  `);
  void notifyArContactRequest(producerId, g.handle, message).catch(
    logErr('notifyArContactRequest'),
  );
  return c.json({ sent: true }, 200);
});

// Producer inbox: incoming A&R requests. Any authenticated user (the producer).
arEngagementRoutes.get('/me/ar-requests', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const rows = await db().execute<{
    id: string;
    ar_handle: string;
    message: string;
    status: string;
    created_at: string;
  }>(sql`
    SELECT r.id, u.handle AS ar_handle, r.message, r.status, r.created_at
      FROM ar_contact_requests r JOIN users u ON u.id = r.ar_user_id
     WHERE r.producer_id = ${g.userId}
     ORDER BY r.created_at DESC LIMIT 50
  `);
  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        arHandle: r.ar_handle,
        message: r.message,
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

arEngagementRoutes.post('/me/ar-requests/:id/respond', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { accept?: boolean };
  const accepted = Boolean(body.accept);
  const d = db();
  const [r] = await d.execute<{ ar_user_id: string; status: string }>(sql`
    SELECT ar_user_id, status FROM ar_contact_requests
     WHERE id = ${id} AND producer_id = ${g.userId} LIMIT 1
  `);
  if (!r) return c.json({ error: 'not_found', message: 'Request not found.' }, 404);
  if (r.status !== 'pending') return c.json({ error: 'done', message: 'Already responded.' }, 409);
  await d.execute(sql`
    UPDATE ar_contact_requests SET status = ${accepted ? 'accepted' : 'declined'}, responded_at = now()
     WHERE id = ${id}
  `);
  void notifyArContactResponse(r.ar_user_id, g.handle, accepted).catch(
    logErr('notifyArContactResponse'),
  );
  return c.json({ status: accepted ? 'accepted' : 'declined' }, 200);
});

// ─── A&R Briefs ──────────────────────────────────────────────────────────────

arEngagementRoutes.post('/ar/briefs', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    description?: string;
    genreSlug?: string;
    bpmHint?: string;
    reward?: string;
    deadline?: string;
  };
  const title = (body.title ?? '').trim().slice(0, 120);
  const description = (body.description ?? '').trim().slice(0, 2000);
  if (!title || !description)
    return c.json({ error: 'bad_request', message: 'title + description required' }, 400);
  const deadline = body.deadline ? new Date(body.deadline) : new Date(Date.now() + 7 * 86_400_000);
  if (Number.isNaN(deadline.getTime()))
    return c.json({ error: 'bad_request', message: 'bad deadline' }, 400);
  const d = db();
  const genreId = body.genreSlug
    ? ((
        await d.execute<{ id: string }>(
          sql`SELECT id FROM genres WHERE slug = ${body.genreSlug} LIMIT 1`,
        )
      )[0]?.id ?? null)
    : null;
  const [brief] = await d.execute<{ id: string }>(sql`
    INSERT INTO ar_briefs (ar_user_id, title, description, genre_id, bpm_hint, reward, deadline, status, created_at)
    VALUES (${g.userId}, ${title}, ${description}, ${genreId}, ${body.bpmHint ?? null}, ${body.reward ?? null}, ${deadline.toISOString()}, 'open', now())
    RETURNING id
  `);
  return c.json({ id: brief?.id }, 200);
});

// Public list of open briefs (any authenticated user, so producers can enter).
arEngagementRoutes.get('/briefs', async (c) => {
  const rows = await db().execute<{
    id: string;
    title: string;
    description: string;
    bpm_hint: string | null;
    reward: string | null;
    deadline: string;
    status: string;
    slug: string | null;
    name: string | null;
    ar_handle: string;
    entries: string;
  }>(sql`
    SELECT b.id, b.title, b.description, b.bpm_hint, b.reward, b.deadline, b.status,
           g.slug, g.name, u.handle AS ar_handle,
           (SELECT COUNT(*) FROM ar_brief_submissions WHERE brief_id = b.id)::text AS entries
      FROM ar_briefs b
      LEFT JOIN genres g ON g.id = b.genre_id
      JOIN users u ON u.id = b.ar_user_id
     WHERE b.status IN ('open', 'judging')
     ORDER BY b.deadline ASC LIMIT 50
  `);
  return c.json(
    {
      items: rows.map((b) => ({
        id: b.id,
        title: b.title,
        description: b.description,
        bpmHint: b.bpm_hint,
        reward: b.reward,
        deadline: new Date(b.deadline).toISOString(),
        status: b.status,
        genre: b.slug ? { slug: b.slug, name: b.name } : null,
        arHandle: b.ar_handle,
        entries: Number(b.entries),
      })),
    },
    200,
  );
});

// Brief detail + entries.
arEngagementRoutes.get('/briefs/:id', async (c) => {
  const id = c.req.param('id');
  const d = db();
  const [b] = await d.execute<{
    id: string;
    title: string;
    description: string;
    bpm_hint: string | null;
    reward: string | null;
    deadline: string;
    status: string;
    slug: string | null;
    name: string | null;
    ar_handle: string;
    winner_submission_id: string | null;
  }>(sql`
    SELECT b.id, b.title, b.description, b.bpm_hint, b.reward, b.deadline, b.status,
           g.slug, g.name, u.handle AS ar_handle, b.winner_submission_id
      FROM ar_briefs b LEFT JOIN genres g ON g.id = b.genre_id JOIN users u ON u.id = b.ar_user_id
     WHERE b.id = ${id} LIMIT 1
  `);
  if (!b) return c.json({ error: 'not_found', message: 'Brief not found.' }, 404);
  const subs = await d.execute<{
    id: string;
    producer_handle: string;
    audio_url: string;
    title: string | null;
    note: string | null;
    created_at: string;
  }>(sql`
    SELECT bs.id, u.handle AS producer_handle, bs.audio_url, bs.title, bs.note, bs.created_at
      FROM ar_brief_submissions bs JOIN users u ON u.id = bs.producer_id
     WHERE bs.brief_id = ${id} ORDER BY bs.created_at ASC
  `);
  const entries = await Promise.all(
    subs.map(async (s) => ({
      id: s.id,
      producerHandle: s.producer_handle,
      audioUrl: await signUrl(s.audio_url),
      title: s.title,
      note: s.note,
      createdAt: new Date(s.created_at).toISOString(),
      isWinner: s.id === b.winner_submission_id,
    })),
  );
  return c.json(
    {
      id: b.id,
      title: b.title,
      description: b.description,
      bpmHint: b.bpm_hint,
      reward: b.reward,
      deadline: new Date(b.deadline).toISOString(),
      status: b.status,
      genre: b.slug ? { slug: b.slug, name: b.name } : null,
      arHandle: b.ar_handle,
      winnerSubmissionId: b.winner_submission_id,
      entries,
    },
    200,
  );
});

// Producer enters a brief (one entry per producer).
arEngagementRoutes.post('/briefs/:id/enter', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    audioUrl?: string;
    title?: string;
    note?: string;
  };
  const audioUrl = (body.audioUrl ?? '').trim();
  if (!audioUrl) return c.json({ error: 'bad_request', message: 'audioUrl required' }, 400);
  const d = db();
  const [b] = await d.execute<{ status: string }>(
    sql`SELECT status FROM ar_briefs WHERE id = ${id} LIMIT 1`,
  );
  if (!b) return c.json({ error: 'not_found', message: 'Brief not found.' }, 404);
  if (b.status !== 'open') return c.json({ error: 'closed', message: 'Brief is not open.' }, 403);
  await d.execute(sql`
    INSERT INTO ar_brief_submissions (brief_id, producer_id, audio_url, title, note, created_at)
    VALUES (${id}, ${g.userId}, ${audioUrl}, ${body.title ?? null}, ${body.note ?? null}, now())
    ON CONFLICT (brief_id, producer_id)
      DO UPDATE SET audio_url = EXCLUDED.audio_url, title = EXCLUDED.title, note = EXCLUDED.note
  `);
  return c.json({ entered: true }, 200);
});

// A&R picks the winning entry.
arEngagementRoutes.post('/ar/briefs/:id/winner', async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { submissionId?: string };
  const submissionId = body.submissionId ?? '';
  const d = db();
  const [b] = await d.execute<{ ar_user_id: string; title: string }>(
    sql`SELECT ar_user_id, title FROM ar_briefs WHERE id = ${id} LIMIT 1`,
  );
  if (!b) return c.json({ error: 'not_found', message: 'Brief not found.' }, 404);
  if (b.ar_user_id !== g.userId && c.var.user?.role !== 'admin')
    return c.json({ error: 'forbidden', message: 'Not your brief.' }, 403);
  const [entry] = await d.execute<{ producer_id: string }>(
    sql`SELECT producer_id FROM ar_brief_submissions WHERE id = ${submissionId} AND brief_id = ${id} LIMIT 1`,
  );
  if (!entry) return c.json({ error: 'not_found', message: 'Entry not found.' }, 404);
  await d.execute(sql`
    UPDATE ar_briefs SET winner_submission_id = ${submissionId}, status = 'closed' WHERE id = ${id}
  `);
  void notifyArBriefWinner(entry.producer_id, b.title, g.handle).catch(
    logErr('notifyArBriefWinner'),
  );
  return c.json({ winnerSubmissionId: submissionId }, 200);
});

// ─── Most-Scouted leaderboard ────────────────────────────────────────────────
// Public: producers ranked by distinct A&R interest (picks + cosigns).
arEngagementRoutes.get('/ar/most-scouted', async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
  const rows = await db().execute<{
    id: string;
    handle: string;
    avatar_url: string | null;
    ar_count: string;
    cosigns: string;
    avg_score: string;
  }>(sql`
    SELECT u.id, u.handle, u.avatar_url,
           COUNT(DISTINCT ap.ar_user_id)::text AS ar_count,
           COUNT(*) FILTER (WHERE ap.cosign)::text AS cosigns,
           COALESCE(AVG(ap.score), 0)::text AS avg_score
      FROM users u
      JOIN submissions s ON s.user_id = u.id
      JOIN ar_picks ap ON ap.submission_id = s.id
     GROUP BY u.id, u.handle, u.avatar_url
     ORDER BY ar_count DESC, cosigns DESC, avg_score DESC
     LIMIT ${limit}
  `);
  return c.json(
    {
      items: rows.map((r) => ({
        producerId: r.id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
        arScouts: Number(r.ar_count),
        cosigns: Number(r.cosigns),
        avgScore: Number(Number(r.avg_score).toFixed(2)),
      })),
    },
    200,
  );
});

// ─── Verified A&R (applications) ─────────────────────────────────────────────

// Any authenticated user applies to become a verified A&R.
arEngagementRoutes.post('/ar/apply', async (c) => {
  const g = requireUser(c);
  if (!g.ok) return c.json(g.body, g.status);
  const body = (await c.req.json().catch(() => ({}))) as { labelName?: string; evidence?: string };
  const labelName = (body.labelName ?? '').trim().slice(0, 120);
  const evidence = (body.evidence ?? '').trim().slice(0, 2000);
  if (!labelName || !evidence)
    return c.json({ error: 'bad_request', message: 'labelName + evidence required' }, 400);
  const d = db();
  const [open] = await d.execute<{ id: string }>(
    sql`SELECT id FROM ar_applications WHERE user_id = ${g.userId} AND status = 'pending' LIMIT 1`,
  );
  if (open)
    return c.json({ error: 'pending', message: 'You already have a pending application.' }, 409);
  await d.execute(sql`
    INSERT INTO ar_applications (user_id, label_name, evidence, status, created_at)
    VALUES (${g.userId}, ${labelName}, ${evidence}, 'pending', now())
  `);
  return c.json({ applied: true }, 200);
});

function requireAdmin(c: Context): ArGuard {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'admin')
    return { ok: false, status: 403, body: { error: 'forbidden', message: 'Admin only.' } };
  return { ok: true, userId: user.id, handle: user.handle ?? '' };
}

arEngagementRoutes.get('/admin/ar/applications', async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);
  const rows = await db().execute<{
    id: string;
    handle: string;
    label_name: string;
    evidence: string;
    status: string;
    created_at: string;
  }>(sql`
    SELECT a.id, u.handle, a.label_name, a.evidence, a.status, a.created_at
      FROM ar_applications a JOIN users u ON u.id = a.user_id
     WHERE a.status = 'pending'
     ORDER BY a.created_at ASC
  `);
  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        handle: r.handle,
        labelName: r.label_name,
        evidence: r.evidence,
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

arEngagementRoutes.post('/admin/ar/applications/:id/review', async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { approve?: boolean; note?: string };
  const approve = Boolean(body.approve);
  const d = db();
  const [app] = await d.execute<{ user_id: string; status: string }>(
    sql`SELECT user_id, status FROM ar_applications WHERE id = ${id} LIMIT 1`,
  );
  if (!app) return c.json({ error: 'not_found', message: 'Application not found.' }, 404);
  if (app.status !== 'pending') return c.json({ error: 'done', message: 'Already reviewed.' }, 409);
  await d.execute(sql`
    UPDATE ar_applications
       SET status = ${approve ? 'approved' : 'rejected'}, reviewer_id = ${g.userId},
           review_note = ${body.note ?? null}, reviewed_at = now()
     WHERE id = ${id}
  `);
  if (approve) {
    await d.execute(
      sql`UPDATE users SET role = 'ar' WHERE id = ${app.user_id} AND role = 'producer'`,
    );
  }
  return c.json({ status: approve ? 'approved' : 'rejected' }, 200);
});
