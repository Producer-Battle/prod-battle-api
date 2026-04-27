// applyRankedOutcome - called at the results phase for ranked matches.
// Computes pairwise Elo updates against the current season's rankings
// row for each (player, genre) and writes lp_delta back to match_players
// so the post-match UI can show the change.
//
// We're using simple Elo (not full Glicko-2) for now because FFA Glicko
// is non-trivial; a real Glicko-2 update can replace this without
// schema or call-site changes. The rating field is still called
// glickoRating for backward compat with existing rows.
//
// K-factor scales:
//   - During calibration (users.calibration_matches_remaining > 0): K=48
//   - After calibration: K=24
//   - LP move further clamped by rules.tiers.lpClampBase + lpClampPerLp
//     so a Master player isn't punished by an off-peak match against a
//     Bronze.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { matchPlayers, matches, rankings, submissions, users } from '../db/schema.js';
import { activeSeason, getCategory } from '../game-rules/loader.js';
import { tickCalibration } from './index.js';

interface PlayerOutcome {
  userId: string;
  /** Final rank in the match (1=winner). Higher = worse. */
  rank: number;
  /** Numeric rating BEFORE this match. */
  ratingBefore: number;
  /** Total LP delta computed across all pairings. */
  delta: number;
  /** True while users.calibration_matches_remaining > 0. */
  calibrating: boolean;
}

export async function applyRankedOutcome(matchId: string): Promise<void> {
  const d = db();

  const [m] = await d.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m) return;
  if (m.mode !== 'ranked') return;
  if (!m.primaryGenreId) return;

  const season = await activeSeason();
  const tierRules = await getCategory('tiers');

  // Gather seated players + their final rank + their current rating.
  // tallyResults writes finalRank to submissions, not match_players, so
  // we join through submissions to recover the rank per (match, user).
  const players = await d
    .select({
      userId: matchPlayers.userId,
      finalRank: submissions.finalRank,
      calibrating: users.calibrationMatchesRemaining,
    })
    .from(matchPlayers)
    .innerJoin(users, eq(users.id, matchPlayers.userId))
    .innerJoin(
      submissions,
      and(eq(submissions.matchId, matchPlayers.matchId), eq(submissions.userId, matchPlayers.userId)),
    )
    .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.isSpectator, false)));

  // Drop anyone with no final rank (abandoned, didn't submit, vote tie
  // edge case). Need ≥ 2 ranked players to produce any LP movement.
  const ranked = players.filter((p) => p.finalRank !== null);
  if (ranked.length < 2) return;

  // Lazy-create or fetch the ranking row for each player in this genre.
  // Default rating 1500 / RD 350 (matches schema defaults).
  const ratings = new Map<string, number>();
  for (const p of ranked) {
    const [row] = await d
      .select({ rating: rankings.glickoRating })
      .from(rankings)
      .where(
        and(
          eq(rankings.userId, p.userId),
          eq(rankings.genreId, m.primaryGenreId),
          eq(rankings.seasonId, season.id),
        ),
      )
      .limit(1);
    if (row) {
      ratings.set(p.userId, Number(row.rating));
    } else {
      await d
        .insert(rankings)
        .values({
          userId: p.userId,
          genreId: m.primaryGenreId,
          seasonId: season.id,
        })
        .onConflictDoNothing();
      ratings.set(p.userId, 1500);
    }
  }

  // Pairwise Elo update across the FFA bracket.
  const outcomes: PlayerOutcome[] = ranked.map((p) => ({
    userId: p.userId,
    rank: p.finalRank ?? 0,
    ratingBefore: ratings.get(p.userId) ?? 1500,
    delta: 0,
    calibrating: p.calibrating > 0,
  }));

  for (let i = 0; i < outcomes.length; i++) {
    for (let j = i + 1; j < outcomes.length; j++) {
      const a = outcomes[i];
      const b = outcomes[j];
      if (!a || !b) continue;
      const k = a.calibrating || b.calibrating ? 48 : 24;
      // Expected = 1 / (1 + 10^((Rb - Ra)/400))
      const ea = 1 / (1 + 10 ** ((b.ratingBefore - a.ratingBefore) / 400));
      const eb = 1 - ea;
      // sa: 1 = a beat b, 0 = b beat a, 0.5 if tied (same rank).
      const sa = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
      const sb = 1 - sa;
      a.delta += k * (sa - ea);
      b.delta += k * (sb - eb);
    }
  }

  // Apply per-rank LP clamp from rules: cap = lpClampBase + (myLP / lpClampPerLp)
  for (const o of outcomes) {
    const cap = tierRules.lpClampBase + Math.floor(o.ratingBefore / tierRules.lpClampPerLp);
    if (o.delta > cap) o.delta = cap;
    if (o.delta < -cap) o.delta = -cap;
  }

  // Persist: update rankings row, record lp_delta, tick calibration.
  for (const o of outcomes) {
    const newRating = Math.max(0, Math.round(o.ratingBefore + o.delta));
    await d
      .update(rankings)
      .set({
        glickoRating: String(newRating),
        wins: o.rank === 1 ? sql`${rankings.wins} + 1` : sql`${rankings.wins}`,
        losses: o.rank > 1 ? sql`${rankings.losses} + 1` : sql`${rankings.losses}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rankings.userId, o.userId),
          eq(rankings.genreId, m.primaryGenreId),
          eq(rankings.seasonId, season.id),
        ),
      );
    await d
      .update(matchPlayers)
      .set({ lpDelta: Math.round(o.delta) })
      .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, o.userId)));
    await tickCalibration(o.userId);
  }
}
