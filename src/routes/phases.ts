// Phase-specific endpoints:
//   GET  /matches/votable        - matches currently open for voting
//   GET  /matches/:code/reveal   - anonymized submissions for the reveal
//   POST /rooms/:code/vote       - cast a vote per submission
//   GET  /matches/:code/results  - final leaderboard with revealed identities

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import { matchPlayers, matches, submissions, users, votes } from '../db/schema.js';
import { getCategory } from '../game-rules/loader.js';
import { maybeAdvanceAfterVote } from '../room/transitions.js';
import { computeVoteWeight } from '../voting/weight.js';

export const phasesRoutes = new OpenAPIHono();

// ─── GET /matches/:code/reveal ───────────────────────────────────────────
// Returns the submissions for this match, ANONYMIZED (Entry A, Entry B...),
// in a stable but non-ordered-by-submitter order so Alice and Bob see the
// same sequence. Identities are revealed via /results once voting closes.

const revealRoute = createRoute({
  method: 'get',
  path: '/matches/{code}/reveal',
  tags: ['phases'],
  summary: 'Anonymized submissions for the reveal phase',
  request: {
    params: z.object({ code: z.string() }),
    // Guests aren't authenticated, so we accept ?user=<handle> to compute
    // isOwn for them. Authenticated callers' session takes priority.
    query: z.object({ user: z.string().optional() }),
  },
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
                // True only for the caller's own submission. Lets the
                // client disable scoring on their own track so they cant
                // 5-star themselves. Server still drops self-votes
                // silently if the client tries.
                isOwn: z.boolean(),
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
  const { user: handleParam } = c.req.valid('query');
  const d = db();

  // Auth session wins; fall back to ?user=<handle> for guests so isOwn
  // still works for unauthenticated producers.
  let callerId: string | null = c.var.user?.id ?? null;
  if (!callerId && handleParam) {
    const [u] = await d
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handleParam))
      .limit(1);
    callerId = u?.id ?? null;
  }

  const [m] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  if (!m) return c.json({ error: 'match not found' }, 404);

  const rows = await d
    .select({
      id: submissions.id,
      userId: submissions.userId,
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
      isOwn: callerId !== null && r.userId === callerId,
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

  // All modes require status='vote' to accept ballots. Daily matches used to
  // allow voting during 'submit' and 'results' indefinitely; that open-window
  // behaviour is gone - daily now follows the same two-day cycle as other
  // modes and votes are only accepted during the dedicated vote window.
  if (m.status !== 'vote') {
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

  // Min-matches gate: blocks fresh-account vote farms from drive-by
  // /vote audience clicks. Seated players in the current match are
  // EXEMPT - they're casting peer votes inside their own match, which is
  // the whole point of the mechanic. Configurable via
  // game_rules.voting.minMatchesBeforeVotesCount.
  const votingRules = await getCategory('voting');
  if (votingRules.minMatchesBeforeVotesCount > 0) {
    const [seated] = await d
      .select({ n: count() })
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, m.id), eq(matchPlayers.userId, u.id)));
    const isSeated = Number(seated?.n ?? 0) > 0;
    if (!isSeated) {
      const [played] = await d
        .select({ n: count() })
        .from(matchPlayers)
        .where(and(eq(matchPlayers.userId, u.id), eq(matchPlayers.abandoned, false)));
      if (Number(played?.n ?? 0) < votingRules.minMatchesBeforeVotesCount) {
        return c.json(
          {
            error: 'too_new',
            message: `Play at least ${votingRules.minMatchesBeforeVotesCount} matches before your votes count.`,
          },
          403,
        );
      }
    }
  }

  // Load all submissions in this match so we can enforce no-self-vote and
  // only-valid-ids.
  const subs = await d
    .select({ id: submissions.id, userId: submissions.userId })
    .from(submissions)
    .where(eq(submissions.matchId, m.id));
  const subById = new Map(subs.map((s) => [s.id, s]));

  // Self-vote silently filtered. The reveal phase is anonymous so a player
  // can't tell which entry is theirs - rejecting the whole batch with 403
  // would block them from voting at all if they happen to click their own.
  // We just drop those votes and keep the rest.
  const ownSubmissionIds = new Set(subs.filter((s) => s.userId === u.id).map((s) => s.id));

  // Build the voter's fingerprint identity set once.
  // canvasHash + screenDims is the strongest device signal (userAgent drifts
  // across browser updates; timezone can be spoofed cheaply).
  const voterFps = new Set(
    (u.deviceFingerprints ?? []).map((f) => `${f.canvasHash}|${f.screenDims}`),
  );

  // Batch-load device fingerprints for all submitters in this match.
  // Keyed by submitter userId -> Set<"canvasHash|screenDims">.
  const submitterUserIds = [...new Set(subs.map((s) => s.userId).filter(Boolean))];
  const submitterFpMap = new Map<string, Set<string>>();
  if (submitterUserIds.length > 0) {
    // Drizzle's inArray builds a proper Postgres array literal so this
    // works regardless of how many ids are in the list. Earlier raw-sql
    // version with `ANY(${submitterUserIds})` produced `ANY(($1, $2))`,
    // a tuple, which Postgres rejects with
    // "op ANY/ALL (array) requires array on right side".
    const submitterRows = await d
      .select({ id: users.id, deviceFingerprints: users.deviceFingerprints })
      .from(users)
      .where(inArray(users.id, submitterUserIds));
    for (const row of submitterRows) {
      const fpSet = new Set<string>(
        (row.deviceFingerprints ?? []).map((f) => `${f.canvasHash}|${f.screenDims}`),
      );
      submitterFpMap.set(row.id, fpSet);
    }
  }

  // Velocity cap: maximum votes a single submission may receive within a
  // rolling 1-hour window. Configurable via
  // game_rules.voting.velocityCapPerSubmissionPerHour. 0 = no cap.
  const velocityCap = votingRules.velocityCapPerSubmissionPerHour;

  // Apply honor + premium multiplier to the raw 1-5 score before storing.
  const isPremium = u.plan === 'paid';
  const weightFor = (rawScore: number): number =>
    computeVoteWeight({ rawScore, honor: u.honor, isPremium, rules: votingRules });

  let accepted = 0;
  for (const v of body.votes) {
    const s = subById.get(v.submissionId);
    if (!s) continue; // bad id - ignore
    if (ownSubmissionIds.has(v.submissionId)) continue; // self-vote silent drop

    // Fingerprint collision check: if the voter shares a device signature
    // with the submitter, drop the vote silently (sock-puppet upvote guard).
    if (voterFps.size > 0 && s.userId) {
      const submitterFps = submitterFpMap.get(s.userId) ?? new Set<string>();
      let collision = false;
      for (const fp of voterFps) {
        if (submitterFps.has(fp)) {
          collision = true;
          break;
        }
      }
      if (collision) {
        console.warn('[vote] dropped fp-collision', {
          matchId: m.id,
          voterId: u.id,
          submissionId: v.submissionId,
        });
        continue; // silent drop
      }
    }

    // Velocity cap: count votes already cast on this submission in the
    // trailing hour. Drop this vote if already at the cap.
    if (velocityCap > 0) {
      const [capRow] = await d.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n
              FROM votes
             WHERE submission_id = ${v.submissionId}
               AND created_at > now() - interval '1 hour'`,
      );
      const currentCount = Number((capRow as { n: string } | undefined)?.n ?? 0);
      if (currentCount >= velocityCap) {
        console.warn('[vote] velocity cap hit', {
          matchId: m.id,
          submissionId: v.submissionId,
          cap: velocityCap,
        });
        continue; // silent drop
      }
    }

    // Upsert (match, voter, submission) with the weighted score.
    const weight = weightFor(v.score);
    await d
      .insert(votes)
      .values({
        matchId: m.id,
        voterId: u.id,
        submissionId: v.submissionId,
        weight: String(weight),
      })
      .onConflictDoUpdate({
        target: [votes.matchId, votes.voterId, votes.submissionId],
        set: { weight: String(weight) },
      });
    accepted++;
  }

  // For non-daily matches: short-circuit to results if every eligible voter is done.
  // Daily matches are advanced by the nightly dailyRolloverCheck, not here.
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
                mode: z.enum(['quickplay', 'ranked', 'private', 'flip', 'daily', 'tournament']),
                phase: z.string(),
                transitionsAt: z.number().int().nullable(),
                genre: z.object({ slug: z.string(), name: z.string() }),
                submissions: z.array(
                  z.object({
                    submissionId: z.string().uuid(),
                    label: z.string(),
                    audioUrl: z.string().url(),
                    durationSec: z.number().int().nullable(),
                    // True when the caller is signed in and this is their
                    // own submission. The /vote page disables scoring; the
                    // server still drops self-votes silently as defense.
                    isOwn: z.boolean(),
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
  const callerId = c.var.user?.id ?? null;

  const matchRows = await d.execute<{
    match_id: string;
    room_code: string;
    mode: 'quickplay' | 'ranked' | 'private' | 'flip' | 'daily' | 'tournament';
    phase: string;
    transitions_at: string | null;
    genre_slug: string;
    genre_name: string;
  }>(
    sql`SELECT m.id AS match_id, m.room_code, m.mode, m.status AS phase,
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
    user_id: string | null;
    audio_url: string;
    duration_sec: number | null;
  }>(
    sql`SELECT id, match_id, user_id, audio_url, duration_sec
          FROM submissions
         WHERE match_id = ANY(${matchIds})
         ORDER BY id`,
  );

  type SubRow = {
    id: string;
    match_id: string;
    user_id: string | null;
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
      mode: m.mode,
      phase: m.phase,
      transitionsAt: m.transitions_at ? new Date(m.transitions_at).getTime() : null,
      genre: { slug: m.genre_slug, name: m.genre_name },
      submissions: await Promise.all(
        (subsByMatch.get(m.match_id) ?? []).map(async (s, i) => ({
          submissionId: s.id,
          label: `Entry ${String.fromCharCode(65 + i)}`,
          audioUrl: await signUrl(s.audio_url, 3600),
          durationSec: s.duration_sec,
          isOwn: callerId !== null && s.user_id === callerId,
        })),
      ),
    })),
  );

  return c.json({ items });
});
