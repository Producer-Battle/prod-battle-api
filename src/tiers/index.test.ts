// Pure unit tests for the tier-mapping math. No DB; we pass a TierRules
// object directly to glickoToTier(rules).

import { describe, expect, it } from 'vitest';
import type { TierRules } from '../game-rules/types.js';
import { glickoToTier } from './index.js';

const RULES: TierRules = {
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

describe('glickoToTier', () => {
  it('puts 0 in Bronze III (the very bottom)', async () => {
    const t = await glickoToTier(0, RULES);
    expect(t.name).toBe('bronze');
    expect(t.label).toBe('Bronze III');
  });

  it('places 1500 default in Diamond', async () => {
    const t = await glickoToTier(1500, RULES);
    expect(t.name).toBe('diamond');
    // 1500 sits in the [1000, 2000) span, slice 2 of 3 = Diamond II.
    expect(t.label).toBe('Diamond II');
  });

  it('top of bronze is Bronze I', async () => {
    const t = await glickoToTier(99, RULES);
    expect(t.name).toBe('bronze');
    expect(t.label).toBe('Bronze I');
  });

  it('exactly at tier border lands in next tier (max-exclusive)', async () => {
    const t = await glickoToTier(100, RULES);
    expect(t.name).toBe('silver');
    expect(t.label).toBe('Silver III');
  });

  it('Grandmaster has no sub-division', async () => {
    const t = await glickoToTier(5000, RULES);
    expect(t.name).toBe('grandmaster');
    expect(t.label).toBe('Grandmaster');
    expect(t.division).toBe(1);
  });

  it('rounds non-integer rating into LP', async () => {
    const t = await glickoToTier(1234.6, RULES);
    expect(t.lp).toBe(1235);
  });
});
