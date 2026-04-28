import { describe, expect, it } from 'vitest';
import type { VotingRules } from '../game-rules/types.js';
import { computeVoteWeight, honorMultiplier } from './weight.js';

const RULES: VotingRules = {
  minMatchesBeforeVotesCount: 3,
  selfVoteAllowed: false,
  downvotesEnabled: false,
  honorWeightCurve: [
    { honorMin: 0, weight: 0 },
    { honorMin: 30, weight: 1.0 },
    { honorMin: 90, weight: 1.5 },
    { honorMin: 100, weight: 1.5 },
  ],
  premiumVoteWeightBonus: 0.25,
  velocityCapPerSubmissionPerHour: 30,
  ringDetection: { enabled: true, minMutualVotePairs: 5, maxIntervalMinutes: 5 },
};

describe('voting/weight', () => {
  it('honor 0 weighs nothing', () => {
    expect(honorMultiplier(0, RULES.honorWeightCurve)).toBe(0);
    expect(honorMultiplier(29, RULES.honorWeightCurve)).toBe(0);
  });

  it('honor 30..89 weighs 1.0', () => {
    expect(honorMultiplier(30, RULES.honorWeightCurve)).toBe(1.0);
    expect(honorMultiplier(89, RULES.honorWeightCurve)).toBe(1.0);
  });

  it('honor 90+ weighs 1.5', () => {
    expect(honorMultiplier(90, RULES.honorWeightCurve)).toBe(1.5);
    expect(honorMultiplier(100, RULES.honorWeightCurve)).toBe(1.5);
  });

  it('premium plan does NOT change vote weight (Supporter has no in-match advantage)', () => {
    const free = computeVoteWeight({ rawScore: 4, honor: 100, isPremium: false, rules: RULES });
    const paid = computeVoteWeight({ rawScore: 4, honor: 100, isPremium: true, rules: RULES });
    expect(free).toBe(4 * 1.5);
    expect(paid).toBe(free);
  });

  it('low-honor voter contributes 0 regardless of plan', () => {
    const paid = computeVoteWeight({ rawScore: 5, honor: 5, isPremium: true, rules: RULES });
    const free = computeVoteWeight({ rawScore: 5, honor: 5, isPremium: false, rules: RULES });
    expect(paid).toBe(0);
    expect(free).toBe(0);
  });
});
