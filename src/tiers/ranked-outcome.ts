// applyRankedOutcome - called at the results phase for ranked matches.
// Computes Glicko-2 updates for each player against all other players in the
// match, then writes the new rating/RD/volatility back to rankings and records
// lp_delta on match_players for the post-match UI.
//
// Pairwise score derivation (FFA and team both reduce to this):
//   score = 1 if this player's rank is strictly better (lower number)
//   score = 0 if this player's rank is strictly worse
//   score = 0.5 if ranks are equal (tie)

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { matchPlayers, matches, rankings, submissions } from '../db/schema.js';
import { activeSeason } from '../game-rules/loader.js';
import { updateRating } from '../ranking/glicko2.js';
import { tickCalibration } from './index.js';

interface PlayerState {
  userId: string;
  rank: number;
  rating: number;
  rd: number;
  volatility: number;
}

export async function applyRankedOutcome(matchId: string): Promise<void> {
  const d = db();

  const [m] = await d.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m) return;
  if (m.mode !== 'ranked') return;
  if (!m.primaryGenreId) return;

  const season = await activeSeason();

  const players = await d
    .select({
      userId: matchPlayers.userId,
      finalRank: submissions.finalRank,
    })
    .from(matchPlayers)
    .innerJoin(
      submissions,
      and(
        eq(submissions.matchId, matchPlayers.matchId),
        eq(submissions.userId, matchPlayers.userId),
      ),
    )
    .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.isSpectator, false)));

  const ranked = players.filter((p) => p.finalRank !== null);
  if (ranked.length < 2) return;

  // Fetch or lazy-create rankings rows.
  const states: PlayerState[] = [];
  for (const p of ranked) {
    const [row] = await d
      .select({
        rating: rankings.glickoRating,
        rd: rankings.glickoRd,
        volatility: rankings.glickoVolatility,
      })
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
      states.push({
        userId: p.userId,
        rank: p.finalRank ?? 0,
        rating: Number(row.rating),
        rd: Number(row.rd),
        volatility: Number(row.volatility),
      });
    } else {
      await d
        .insert(rankings)
        .values({
          userId: p.userId,
          genreId: m.primaryGenreId,
          seasonId: season.id,
        })
        .onConflictDoNothing();
      states.push({
        userId: p.userId,
        rank: p.finalRank ?? 0,
        rating: 1500,
        rd: 350,
        volatility: 0.06,
      });
    }
  }

  // Compute Glicko-2 update for each player against all others.
  const results = states.map((p) => {
    const opponents = states
      .filter((o) => o.userId !== p.userId)
      .map((o) => ({
        rating: o.rating,
        rd: o.rd,
        score: p.rank < o.rank ? 1 : p.rank > o.rank ? 0 : 0.5,
      }));
    const updated = updateRating(
      { rating: p.rating, rd: p.rd, volatility: p.volatility },
      opponents,
    );
    return { userId: p.userId, rank: p.rank, ratingBefore: p.rating, updated };
  });

  // Persist updates.
  for (const r of results) {
    const newRating = Math.max(0, r.updated.rating);
    await d
      .update(rankings)
      .set({
        glickoRating: String(newRating.toFixed(3)),
        glickoRd: String(r.updated.rd.toFixed(3)),
        glickoVolatility: r.updated.volatility,
        wins: r.rank === 1 ? sql`${rankings.wins} + 1` : sql`${rankings.wins}`,
        losses: r.rank > 1 ? sql`${rankings.losses} + 1` : sql`${rankings.losses}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rankings.userId, r.userId),
          eq(rankings.genreId, m.primaryGenreId),
          eq(rankings.seasonId, season.id),
        ),
      );
    await d
      .update(matchPlayers)
      .set({ lpDelta: Math.round(r.updated.rating - r.ratingBefore) })
      .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, r.userId)));
    await tickCalibration(r.userId);
  }
}
