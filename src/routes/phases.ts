// Phase-specific endpoints:
//   GET  /matches/votable        - matches currently open for voting
//   GET  /matches/:code/reveal   - anonymized submissions for the reveal
//   POST /rooms/:code/vote       - cast a vote per submission
//   GET  /matches/:code/results  - final leaderboard with revealed identities

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import { matches, submissions, users, votes } from '../db/schema.js';
import { maybeAdvanceAfterVote } from '../room/transitions.js';

export const phasesRoutes = new OpenAPIHono();

// ─── GET /matches/:code/reveal ───────────────────────────────────────────
// Returns the submissions for this match, ANONYMIZED (Entry A, Entry B…),
// in a stable but non-ordered-by-submitter order so Alice and Bob see the
// same sequence. Identities are revealed via /results once voting closes.

const revealRoute = createRoute({
  method: 'get',
  path: '/matches/{code}/reveal',
  tags: ['phases'],
  summary: 'Anonymized submissions for the reveal phase',
  request: { params: z.object({ code: z.string() }) },
  responses: {
    200: {
      description: 'Submissions in play order',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                submissionId: z.string().uuid(),
                label: z.string(), // "Entry A"
                audioUrl: z.string().url(),
                durationSec: z.number().int().nullable(),
              }),
            ),
          }),
        },
      },
    },
    404: { description: 'Match not found' },
  },
});

phasesRoutes.openapi(revealRoute, async (c) => {
  const { code } = c.req.valid('param');
  const d = db();
  const [m] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  if (!m) return c.json({ error: 'match not found' }, 404);

  const rows = await d
    .select({
      id: submissions.id,
      audioUrl: submissions.audioUrl,
      durationSec: submissions.durationSec,
    })
    .from(submissions)
    .where(eq(submissions.matchId, m.id))
    .orderBy(submissions.id); // stable, not by user

  const items = await Promise.all(
    rows.map(async (r, i) => ({
      submissionId: r.id,
      label: `Entry ${String.fromCharCode(65 + i)}`,
      audioUrl: await signUrl(r.audioUrl, 3600),
      durationSec: r.durationSec,
    })),
  );

  return c.json({ items });
});

// ─── POST /rooms/:code/vote ─────────────────────────────────────────────
// Body: { user: "handle", votes: [{ submissionId, score: 1..5 }, ...] }
// Rules: match must be in `vote` phase; voter must be a seated player;
//         can't vote for own submission.

const voteBody = z.object({
  user: z.string().min(1),
  votes: z
    .array(
      z.object({
        submissionId: z.string().uuid(),
        score: z.number().int().min(1).max(5),
      }),
    )
    .min(1)
    .max(16),
});

const voteRoute = createRoute({
  method: 'post',
  path: '/rooms/{code}/vote',
  tags: ['phases'],
  summary: 'Cast votes for this match',
  request: {
    params: z.object({ code: z.string() }),
    body: { content: { 'application/json': { schema: voteBody } } },
  },
  responses: {
    200: {
      description: 'Votes recorded',
      content: { 'application/json': { schema: z.object({ accepted: z.number().int() }) } },
    },
    400: { description: 'Validation or phase error' },
    404: { description: 'Match or user not found' },
  },
});

phasesRoutes.openapi(voteRoute, async (c) => {
  const { code } = c.req.valid('param');
  const body = c.req.valid('json');

  const d = db();
  const [m] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  if (!m) return c.json({ error: 'match not found' }, 404);

  // Daily matches allow voting at any time (both 'submit' and 'results' status).
  // All other modes require vote phase. 'reveal' is no longer a valid phase.
  if (m.mode !== 'daily' && m.status !== 'vote') {
    return c.json({ error: `match not in vote phase (status=${m.status})` }, 400);
  }

  // Auto-create a lightweight user row so external/audience voters from
  // the /vote page can cast a vote even if they never joined the match
  // via WS. Self-vote is still blocked below by checking submission.user_id.
  const existing = await d.select().from(users).where(eq(users.handle, body.user)).limit(1);
  let u = existing[0];
  if (!u) {
    const inserted = await d.execute<{ id: string }>(
      sql`INSERT INTO users (id, email, handle, role)
            VALUES (gen_random_uuid(), ${body.user} || '@guest.local', ${body.user}, 'producer')
            ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle
            RETURNING id`,
    );
    const row = inserted[0] as { id: string } | undefined;
    if (row) {
      [u] = await d.select().from(users).where(eq(users.id, row.id)).limit(1);
    }
  }
  if (!u) return c.json({ error: 'user not found' }, 404);

  // Load all submissions in this match so we can enforce no-self-vote and
  // only-valid-ids.
  const subs = await d
    .select({ id: submissions.id, userId: submissions.userId })
    .from(submissions)
    .where(eq(submissions.matchId, m.id));
  const subById = new Map(subs.map((s) => [s.id, s]));

  // Self-vote check: if any vote targets the caller's own submission, reject
  // the entire request with 403 rather than silently dropping it.
  for (const v of body.votes) {
    const s = subById.get(v.submissionId);
    if (s && s.userId === u.id) {
      return c.json({ error: 'self_vote', message: "You can't vote for your own track." }, 403);
    }
  }

  let accepted = 0;
  for (const v of body.votes) {
    const s = subById.get(v.submissionId);
    if (!s) continue; // bad id - ignore

    // Upsert (match, voter, submission) -> weight=score
    await d
      .insert(votes)
      .values({
        matchId: m.id,
        voterId: u.id,
        submissionId: v.submissionId,
        weight: String(v.score),
      })
      .onConflictDoUpdate({
        target: [votes.matchId, votes.voterId, votes.submissionId],
        set: { weight: String(v.score) },
      });
    accepted++;
  }

  // For non-daily matches: short-circuit to results if every eligible voter is done.
  // Daily matches stay in their current status - voting is always open.
  if (m.mode !== 'daily') {
    await maybeAdvanceAfterVote(m.id);
  }

  return c.json({ accepted });
});

// ─── GET /matches/:code/results ─────────────────────────────────────────
// Revealed leaderboard: rank · producer handle · score · audio URL.

const resultsRoute = createRoute({
  method: 'get',
  path: '/matches/{code}/results',
  tags: ['phases'],
  summary: 'Final leaderboard for the match',
  request: { params: z.object({ code: z.string() }) },
  responses: {
    200: {
      description: 'Results',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                rank: z.number().int(),
                submissionId: z.string().uuid(),
                handle: z.string(),
                title: z.string().nullable(),
                audioUrl: z.string().url(),
                score: z.number(),
              }),
            ),
          }),
        },
      },
    },
    404: { description: 'Match not found' },
  },
});

phasesRoutes.openapi(resultsRoute, async (c) => {
  const { code } = c.req.valid('param');
  const d = db();
  const [m] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  if (!m) return c.json({ error: 'match not found' }, 404);

  const rows = await d.execute<{
    final_rank: number;
    submission_id: string;
    handle: string;
    title: string | null;
    audio_url: string;
    score: string | number;
  }>(
    sql`SELECT s.final_rank, s.id AS submission_id, u.handle, s.title,
               s.audio_url, s.score
          FROM submissions s
          JOIN users u ON u.id = s.user_id
         WHERE s.match_id = ${m.id}
         ORDER BY COALESCE(s.final_rank, 9999) ASC, s.created_at ASC`,
  );

  const items = await Promise.all(
    rows.map(async (r) => ({
      rank: r.final_rank ?? 0,
      submissionId: r.submission_id,
      handle: r.handle,
      title: r.title,
      audioUrl: await signUrl(r.audio_url, 3600),
      score: Number(r.score),
    })),
  );

  return c.json({ items });
});

// ─── GET /audience/matches ──────────────────────────────────────────────
// Lists every match currently open for voting (reveal or vote phase) so a
// /vote page can hand audience listeners something to score. Separate path
// from /matches/:code to avoid Hono treating "votable" as a room code.

const votableRoute = createRoute({
  method: 'get',
  path: '/audience/matches',
  tags: ['phases'],
  summary: 'Matches currently accepting votes',
  responses: {
    200: {
      description: 'Votable matches (may be empty)',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                roomCode: z.string(),
                phase: z.string(),
                transitionsAt: z.number().int().nullable(),
                genre: z.object({ slug: z.string(), name: z.string() }),
                submissions: z.array(
                  z.object({
                    submissionId: z.string().uuid(),
                    label: z.string(),
                    audioUrl: z.string().url(),
                    durationSec: z.number().int().nullable(),
                  }),
                ),
              }),
            ),
          }),
        },
      },
    },
  },
});

phasesRoutes.openapi(votableRoute, async (c) => {
  const d = db();

  const matchRows = await d.execute<{
    match_id: string;
    room_code: string;
    phase: string;
    transitions_at: string | null;
    genre_slug: string;
    genre_name: string;
  }>(
    sql`SELECT m.id AS match_id, m.room_code, m.status AS phase,
               bp.transitions_at,
               g.slug AS genre_slug, g.name AS genre_name
          FROM matches m
          JOIN genres g ON g.id = m.primary_genre_id
          LEFT JOIN battle_phases bp ON bp.match_id = m.id
         WHERE m.status = 'vote'
           AND m.room_code IS NOT NULL
         ORDER BY m.started_at DESC NULLS LAST, m.created_at DESC
         LIMIT 20`,
  );

  if (matchRows.length === 0) {
    return c.json({ items: [] });
  }

  const matchIds = matchRows.map((r) => r.match_id);
  const subRows = await d.execute<{
    id: string;
    match_id: string;
    audio_url: string;
    duration_sec: number | null;
  }>(
    sql`SELECT id, match_id, audio_url, duration_sec
          FROM submissions
         WHERE match_id = ANY(${matchIds})
         ORDER BY id`,
  );

  type SubRow = {
    id: string;
    match_id: string;
    audio_url: string;
    duration_sec: number | null;
  };
  const subsByMatch = new Map<string, SubRow[]>();
  for (const s of subRows) {
    const list = subsByMatch.get(s.match_id) ?? [];
    list.push(s as SubRow);
    subsByMatch.set(s.match_id, list);
  }

  const items = await Promise.all(
    matchRows.map(async (m) => ({
      roomCode: m.room_code,
      phase: m.phase,
      transitionsAt: m.transitions_at ? new Date(m.transitions_at).getTime() : null,
      genre: { slug: m.genre_slug, name: m.genre_name },
      submissions: await Promise.all(
        (subsByMatch.get(m.match_id) ?? []).map(async (s, i) => ({
          submissionId: s.id,
          label: `Entry ${String.fromCharCode(65 + i)}`,
          audioUrl: await signUrl(s.audio_url, 3600),
          durationSec: s.duration_sec,
        })),
      ),
    })),
  );

  return c.json({ items });
});
