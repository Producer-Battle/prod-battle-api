// Vote weight calculation: per-vote multiplier derived from the voter's
// honor and plan. Returns the final weight to store in votes.weight.
//
//   raw_score (1..5) * (honorWeight + premium ? premiumBonus : 0)
//
// honorWeight comes from the rules.voting.honorWeightCurve - a step
// function over honor breakpoints. Default curve:
//   honor < 30  -> 0   (votes don't count, low-trust)
//   honor 30-89 -> 1.0
//   honor 90+   -> 1.5
//
// premiumBonus stacks additively on top of honorWeight.

import type { VotingRules } from '../game-rules/types.js';

export function honorMultiplier(honor: number, curve: VotingRules['honorWeightCurve']): number {
  // Curve is sorted ASC by honorMin. Pick the LAST breakpoint <= honor.
  let weight = 0;
  for (const step of curve) {
    if (honor >= step.honorMin) weight = step.weight;
  }
  return weight;
}

export function computeVoteWeight(args: {
  rawScore: number;
  honor: number;
  isPremium: boolean;
  rules: VotingRules;
}): number {
  const honorMul = honorMultiplier(args.honor, args.rules.honorWeightCurve);
  const premiumMul = args.isPremium ? args.rules.premiumVoteWeightBonus : 0;
  const totalMul = honorMul + premiumMul;
  return args.rawScore * totalMul;
}
