// Type-safe shapes for each game_rules.payload. The DB stores arbitrary
// JSON; the loader narrows it through these types so call sites don't have
// to deal with `unknown`. Keep this file in lockstep with the seed payloads
// in migration 0017 and the admin editor schema.

export type ModeKey = 'quickplay' | 'ranked' | 'private' | 'flip' | 'daily' | 'tournament';

export type AbandonReason = 'lobby' | 'mid' | 'empty' | 'no_vote';

export type HonorPenaltyKey =
  | `${ModeKey}_${AbandonReason}`
  | 'dmca_first'
  | 'dmca_second'
  | 'dmca_third'
  | 'vote_ring_confirmed';

export interface ShowcaseHonorRules {
  /** Honor awarded to voters who cast at least floor(N/2) valid non-self votes. */
  voter_complete: number;
  /** Honor awarded to the rank-1 showcase entrant. */
  crowd_favorite: number;
  /** Honor awarded to the rank-2 showcase entrant. */
  runner_up: number;
  /** Honor delta applied to entrants who registered but never uploaded. */
  no_show: number;
  /** Multiplier applied to no_show on first offence (mirrors existing forgiveness ladder). */
  no_show_first_offence_factor: number;
}

export interface HonorRules {
  start: number;
  max: number;
  regenPerCleanDay: number;
  regenBurstPerCleanQpMatches: { matches: number; amount: number };
  firstOffenceWindowDays: number;
  firstOffenceMultiplier: number;
  penalties: Record<HonorPenaltyKey, number>;
  gates: {
    tournament: number;
    ranked: number;
    privateHosting: number;
    readOnlyBelow: number;
  };
  perks: {
    trustedAt: number;
    voteWeightBoostAt: number;
    voteWeightBoostMultiplier: number;
    extraQuickplaySlotAt: number;
    extraQuickplaySlotAfterDays: number;
  };
  /** Configurable honor outcomes for the showcase phase. Optional - falls back to hardcoded defaults. */
  showcase?: ShowcaseHonorRules;
}

export interface TierRules {
  calibrationMatches: number;
  softResetPercent: number;
  softResetFloorOffset: number;
  lpClampBase: number;
  lpClampPerLp: number;
  boundaries: Array<{
    name: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'master' | 'grandmaster';
    min: number;
    max: number | null;
  }>;
  subdivisions: number;
  promoSeriesEnabled: boolean;
}

export interface VotingRules {
  minMatchesBeforeVotesCount: number;
  selfVoteAllowed: boolean;
  downvotesEnabled: boolean;
  honorWeightCurve: Array<{ honorMin: number; weight: number }>;
  premiumVoteWeightBonus: number;
  velocityCapPerSubmissionPerHour: number;
  ringDetection: {
    enabled: boolean;
    minMutualVotePairs: number;
    maxIntervalMinutes: number;
  };
}

export interface AchievementRules {
  enabled: Record<string, boolean>;
}

export interface ReconnectRules {
  graceSeconds: number;
  lobbyAutoReadyTimeoutSeconds: number;
  heartbeatIntervalSeconds: number;
}

export interface GameRules {
  honor: HonorRules;
  tiers: TierRules;
  voting: VotingRules;
  achievements: AchievementRules;
  reconnect: ReconnectRules;
}

export type GameRulesCategory = keyof GameRules;
