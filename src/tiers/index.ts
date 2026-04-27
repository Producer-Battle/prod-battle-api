// Player-facing tiers built on top of Glicko ratings.
//
// We don't store tier in the DB - it's a derived view of the rating
// (rankings.glickoRating) so the boundaries stay tunable via game_rules
// without a migration. Convert with glickoToTier().
//
// The mapping converts a 0-3500+ "LP-equivalent" scale into:
//   Bronze III/II/I, Silver III/II/I, ..., Master III/II/I, Grandmaster
// = 19 ranks, equally divided within each tier (default 3 sub-divisions
// except Grandmaster which is the open-ended top).
//
// Calibration: while users.calibration_matches_remaining > 0, the UI
// hides tier and LP and shows "calibrating (N matches left)" instead.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getCategory } from '../game-rules/loader.js';
import type { TierRules } from '../game-rules/types.js';

export type TierName =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'master'
  | 'grandmaster';

export interface Tier {
  /** Lowercase tier name. */
  name: TierName;
  /** Sub-division 1..N where N = rules.tiers.subdivisions. Always 1 for grandmaster. */
  division: number;
  /** Pretty label like "Gold II", or "Grandmaster". */
  label: string;
  /** LP-equivalent integer (just the rounded Glicko rating). */
  lp: number;
}

// Default boundaries used as a safety net if the loader can't reach
// game_rules for some reason (during early server startup, tests, etc.).
// Values mirror migration 0017's seed.
const FALLBACK_TIERS: TierRules = {
  calibrationMatches: 10,
  softResetPercent: 0.6,
  softResetFloorOffset: -1,
  lpClampBase: 30,
  lpClampPerLp: 200,
  boundaries: [
    { name: 'bronze', min: 0, max: 100 },
    { name: 'silver', min: 100, max: 250 },
    { name: 'gold', min: 250, max: 500 },
    { name: 'platinum', min: 500, max: 1000 },
    { name: 'diamond', min: 1000, max: 2000 },
    { name: 'master', min: 2000, max: 3500 },
    { name: 'grandmaster', min: 3500, max: null },
  ],
  subdivisions: 3,
  promoSeriesEnabled: false,
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

function format(name: TierName, division: number, subdivisions: number): string {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  if (name === 'grandmaster') return cap;
  if (subdivisions <= 1) return cap;
  // We display HIGHEST division as I (e.g. Gold I is the top of Gold).
  // boundaries.min..max splits into N equal slices; the LOWEST slice gets
  // the highest roman (III), the HIGHEST slice gets I.
  const idx = subdivisions - division;
  return `${cap} ${ROMAN[idx] ?? String(division)}`;
}

/**
 * Map a Glicko rating to a tier + division.
 *
 * Pass `rules` to inject custom boundaries (test code or for an admin
 * preview). When omitted, uses the loader cache.
 */
export async function glickoToTier(rating: number, rules?: TierRules): Promise<Tier> {
  const r = rules ?? (await getCategory('tiers').catch(() => FALLBACK_TIERS));
  const lp = Math.max(0, Math.round(rating));

  for (const b of r.boundaries) {
    const max = b.max ?? Number.POSITIVE_INFINITY;
    if (lp >= b.min && lp < max) {
      // Sub-divide [min, max) into r.subdivisions equal slices.
      // Slice 1 = lowest LP in the tier.
      if (b.max === null) {
        // Grandmaster: no sub-divisions, no max.
        return {
          name: b.name,
          division: 1,
          label: format(b.name, 1, 1),
          lp,
        };
      }
      const span = (b.max - b.min) / r.subdivisions;
      const subIndex = Math.min(r.subdivisions, Math.floor((lp - b.min) / span) + 1);
      return {
        name: b.name,
        division: subIndex,
        label: format(b.name, subIndex, r.subdivisions),
        lp,
      };
    }
  }
  // Fallback (shouldn't hit if boundaries are well-formed).
  return {
    name: 'bronze',
    division: r.subdivisions,
    label: format('bronze', r.subdivisions, r.subdivisions),
    lp,
  };
}

/**
 * "Display info" for a user's current ranked standing in a genre.
 * Hides tier + LP during calibration so newcomers don't fixate on a
 * half-formed estimate.
 */
export interface DisplayRanking {
  calibrating: boolean;
  matchesLeft: number;
  tier: Tier | null;
  lp: number | null;
}

export async function buildDisplayRanking(
  userId: string,
  glickoRating: number,
): Promise<DisplayRanking> {
  const [u] = await db()
    .select({ left: users.calibrationMatchesRemaining })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const matchesLeft = u?.left ?? 0;
  if (matchesLeft > 0) {
    return { calibrating: true, matchesLeft, tier: null, lp: null };
  }
  const tier = await glickoToTier(glickoRating);
  return { calibrating: false, matchesLeft: 0, tier, lp: tier.lp };
}

/**
 * Decrement calibrationMatchesRemaining when a ranked match completes.
 * Clamped at 0 - never goes negative.
 */
export async function tickCalibration(userId: string): Promise<void> {
  await db()
    .update(users)
    .set({
      calibrationMatchesRemaining: sql`GREATEST(${users.calibrationMatchesRemaining} - 1, 0)`,
    })
    .where(eq(users.id, userId));
}
