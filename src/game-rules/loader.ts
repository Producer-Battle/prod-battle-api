// In-memory cache of game_rules with TTL invalidation. App code calls
// getRules() to read; admin writes call invalidate() to force re-fetch
// on next read. Cheap: one query, no per-request latency.
//
// The cache is process-local. With multiple replicas, each replica
// expires its cache on the same TTL; admin writes propagate within
// the TTL window. For instant propagation we can publish on Redis,
// but the TTL is short enough (30s) that it's not worth the complexity
// for a tuning UI that admins rarely touch.

import { and, gt, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { gameRules, seasons } from '../db/schema.js';
import type {
  AchievementRules,
  GameRules,
  GameRulesCategory,
  HonorRules,
  ReconnectRules,
  TierRules,
  VotingRules,
} from './types.js';

const TTL_MS = 30_000;

// Last fetched payload + its expiry. Set to null on invalidate() so the
// next read forces a refresh.
let cache: { rules: GameRules; expiresAt: number } | null = null;
let inflight: Promise<GameRules> | null = null;

async function fetchAll(): Promise<GameRules> {
  const rows = await db().select().from(gameRules);
  const byCategory = new Map(rows.map((r) => [r.category, r.payload as unknown]));

  const required: GameRulesCategory[] = ['honor', 'tiers', 'voting', 'achievements', 'reconnect'];
  for (const cat of required) {
    if (!byCategory.has(cat)) {
      throw new Error(
        `game_rules row missing for category="${cat}". Re-run migration 0017 or insert manually.`,
      );
    }
  }

  return {
    honor: byCategory.get('honor') as HonorRules,
    tiers: byCategory.get('tiers') as TierRules,
    voting: byCategory.get('voting') as VotingRules,
    achievements: byCategory.get('achievements') as AchievementRules,
    reconnect: byCategory.get('reconnect') as ReconnectRules,
  };
}

export async function getRules(): Promise<GameRules> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.rules;
  if (inflight) return inflight;
  inflight = fetchAll().then(
    (rules) => {
      cache = { rules, expiresAt: Date.now() + TTL_MS };
      inflight = null;
      return rules;
    },
    (err) => {
      inflight = null;
      throw err;
    },
  );
  return inflight;
}

export async function getCategory<K extends GameRulesCategory>(category: K): Promise<GameRules[K]> {
  const rules = await getRules();
  return rules[category];
}

export function invalidate(): void {
  cache = null;
}

export async function setCategory<K extends GameRulesCategory>(
  category: K,
  payload: GameRules[K],
  updatedBy: string | null,
): Promise<void> {
  const d = db();
  await d
    .insert(gameRules)
    .values({ category, payload: payload as object, updatedBy })
    .onConflictDoUpdate({
      target: gameRules.category,
      set: { payload: payload as object, updatedAt: new Date(), updatedBy },
    });
  invalidate();
}

// Test-only: replace the in-memory cache with a synthetic ruleset. Used
// from unit tests so they don't have to seed the DB.
export function _setCacheForTest(rules: GameRules): void {
  cache = { rules, expiresAt: Date.now() + TTL_MS };
}

export function _resetCacheForTest(): void {
  cache = null;
  inflight = null;
}

// Convenience accessor that returns a sync default when the cache is empty.
// Useful for tests that don't await getRules() first.
export function getCachedOrThrow(): GameRules {
  if (!cache) throw new Error('game_rules cache empty - call getRules() first');
  if (cache.expiresAt <= Date.now()) throw new Error('game_rules cache stale');
  return cache.rules;
}

// Returns the id+slug of the season whose [starts_at, ends_at) range
// contains now(). Migration 0017 pre-seeds five quarters; once we run out,
// the admin UI lets us add more (or a cron extends the table).
export async function activeSeason(): Promise<{ id: string; slug: string }> {
  const d = db();
  const now = sql`now()`;
  const rows = await d
    .select({ id: seasons.id, slug: seasons.slug })
    .from(seasons)
    .where(and(lte(seasons.startsAt, now), gt(seasons.endsAt, now)))
    .orderBy(seasons.startsAt)
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      'No active season - check seasons table; migration 0017 seeds five quarters of seasons.',
    );
  }
  return row;
}
