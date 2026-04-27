// Integration test for the game_rules loader. Hits a real DB so we verify
// the migration's seed payloads survive round-tripping through the cache.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetCacheForTest, getCategory, getRules, setCategory } from '../../game-rules/loader.js';

describe('game-rules loader', () => {
  beforeEach(() => {
    _resetCacheForTest();
  });

  afterEach(() => {
    _resetCacheForTest();
  });

  it('loads all six categories from the seed', async () => {
    const rules = await getRules();
    expect(rules.honor.start).toBe(100);
    expect(rules.honor.gates.ranked).toBe(50);
    expect(rules.tiers.calibrationMatches).toBe(10);
    expect(rules.tiers.boundaries).toHaveLength(7);
    expect(rules.voting.minMatchesBeforeVotesCount).toBe(3);
    expect(rules.revenue.creatorPoolPercentOfPremium).toBe(5);
    expect(rules.reconnect.graceSeconds).toBe(120);
    expect(rules.achievements.enabled.tier_grandmaster).toBe(true);
  });

  it('caches between calls', async () => {
    const a = await getRules();
    const b = await getRules();
    expect(a).toBe(b);
  });

  it('setCategory invalidates the cache so the next read gets the new value', async () => {
    const before = await getCategory('honor');
    const original = before.gates.ranked;
    try {
      await setCategory('honor', { ...before, gates: { ...before.gates, ranked: 42 } }, null);
      const after = await getCategory('honor');
      expect(after.gates.ranked).toBe(42);
    } finally {
      // Restore so we don't poison other tests.
      await setCategory('honor', { ...before, gates: { ...before.gates, ranked: original } }, null);
    }
  });
});
