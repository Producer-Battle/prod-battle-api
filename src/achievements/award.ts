// awardAchievement(userId, key) - idempotent INSERT into achievements.
// Skips silently if the achievement is disabled in game_rules.achievements
// (admin can turn off any achievement without code change).
//
// Used by:
//   - applyMatchOutcome(): tier promotions, streak milestones, lifetime
//     match counts, genre mastery
//   - vote handler: votes_lifetime_100, active_listener_10
//   - admin pack promotion: pack_creator_first, pack_iconic_500,
//     producers_producer_5
//   - results phase: daily_champion, weekly_pick, season_finalist_top10
//
// Bulk-evaluate via evaluateMatchEndAchievements(userId, matchMode) - a
// single helper that runs all match-end checks with a few cheap queries.

import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { achievements, matchPlayers, matches, rankings, submissions } from '../db/schema.js';
import { activeSeason, getCategory } from '../game-rules/loader.js';
import { glickoToTier } from '../tiers/index.js';

export async function awardAchievement(userId: string, key: string): Promise<void> {
  const rules = await getCategory('achievements').catch(() => ({
    enabled: {} as Record<string, boolean>,
  }));
  if (rules.enabled && rules.enabled[key] === false) return;

  await db().insert(achievements).values({ userId, achievementKey: key }).onConflictDoNothing();
}

/**
 * Run every match-end achievement check for the given player. Cheap
 * because each check is one indexed COUNT/MAX query at most.
 */
export async function evaluateMatchEndAchievements(
  userId: string,
  matchMode: string,
): Promise<void> {
  await Promise.all([
    checkLifetimeMatchCount(userId),
    checkGenreMastery(userId),
    checkTierPromotion(userId),
    matchMode === 'flip' ? checkRemixMaster(userId) : Promise.resolve(),
  ]).catch(() => {
    /* one failed check shouldn't tank the others */
  });
}

async function checkLifetimeMatchCount(userId: string): Promise<void> {
  const d = db();
  const [row] = await d
    .select({ n: count() })
    .from(matchPlayers)
    .where(and(eq(matchPlayers.userId, userId), eq(matchPlayers.abandoned, false)));
  const n = Number(row?.n ?? 0);
  if (n >= 1000) await awardAchievement(userId, 'match_lifetime_1000');
  if (n >= 100) await awardAchievement(userId, 'match_lifetime_100');
}

async function checkGenreMastery(userId: string): Promise<void> {
  const d = db();
  // Wins per genre = submissions with final_rank=1.
  const rows = await d.execute<{ genre_id: string; wins: string }>(
    sql`SELECT m.primary_genre_id AS genre_id, COUNT(*)::text AS wins
          FROM submissions s
          JOIN matches m ON m.id = s.match_id
         WHERE s.user_id = ${userId} AND s.final_rank = 1
         GROUP BY m.primary_genre_id`,
  );
  const arr = rows as Array<{ genre_id: string; wins: string }>;
  if (arr.some((r) => Number(r.wins) >= 10)) {
    await awardAchievement(userId, 'genre_mastery_10');
  }
}

async function checkRemixMaster(userId: string): Promise<void> {
  const d = db();
  const [row] = await d.execute<{ wins: string }>(
    sql`SELECT COUNT(*)::text AS wins
          FROM submissions s
          JOIN matches m ON m.id = s.match_id
         WHERE s.user_id = ${userId} AND s.final_rank = 1 AND m.mode = 'flip'`,
  );
  const wins = Number((row as { wins: string } | undefined)?.wins ?? 0);
  if (wins >= 50) await awardAchievement(userId, 'remix_master_50');
  if (wins >= 10) await awardAchievement(userId, 'remix_master_10');
}

async function checkTierPromotion(userId: string): Promise<void> {
  // Highest current rating across all (user, genre, season=active).
  const season = await activeSeason().catch(() => null);
  if (!season) return;
  const d = db();
  const [row] = await d
    .select({ rating: rankings.glickoRating })
    .from(rankings)
    .where(and(eq(rankings.userId, userId), eq(rankings.seasonId, season.id)))
    .orderBy(desc(rankings.glickoRating))
    .limit(1);
  if (!row) return;
  const tier = await glickoToTier(Number(row.rating));
  if (tier.name === 'grandmaster') await awardAchievement(userId, 'tier_grandmaster');
  if (['master', 'grandmaster'].includes(tier.name)) await awardAchievement(userId, 'tier_master');
  if (['diamond', 'master', 'grandmaster'].includes(tier.name))
    await awardAchievement(userId, 'tier_diamond');
  if (['platinum', 'diamond', 'master', 'grandmaster'].includes(tier.name))
    await awardAchievement(userId, 'tier_plat');
  if (['gold', 'platinum', 'diamond', 'master', 'grandmaster'].includes(tier.name))
    await awardAchievement(userId, 'tier_gold');
  if (['silver', 'gold', 'platinum', 'diamond', 'master', 'grandmaster'].includes(tier.name))
    await awardAchievement(userId, 'tier_silver');
}

// Re-export to keep imports honest.
export { rankings, matches, submissions };
