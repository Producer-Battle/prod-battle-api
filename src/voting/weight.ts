// Vote weight calculation: per-vote multiplier derived from the voter's
// honor. Returns the final weight to store in votes.weight.
//
//   raw_score (1..5) * honorWeight
//
// honorWeight comes from the rules.voting.honorWeightCurve - a step
// function over honor breakpoints. Default curve:
//   honor < 30  -> 0   (votes don't count, low-trust)
//   honor 30-89 -> 1.0
//   honor 90+   -> 1.5
//
// Note: there used to be a `premiumVoteWeightBonus` that stacked an extra
// multiplier for paid users, but that gave Supporters an in-match
// advantage which contradicts the "Supporter is recognition + cosmetics,
// not pay-to-win" stance. Removed in commit (see git blame). The field
// stays in VotingRules for backwards-compat with existing rules rows in
// game_rules; it's just ignored.

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
  // Kept in the signature so existing callers don't break, but the value
  // is ignored - paid plan grants no extra vote weight.
  isPremium: boolean;
  rules: VotingRules;
}): number {
  const honorMul = honorMultiplier(args.honor, args.rules.honorWeightCurve);
  return args.rawScore * honorMul;
}
