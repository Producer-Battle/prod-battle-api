// Catalogue of achievement keys + display metadata. The DB stores only
// (userId, achievementKey, earnedAt, hiddenByUser) so the catalogue is
// the source of truth for human-readable titles and descriptions.
//
// To add a new achievement:
//   1. Add a key + entry below.
//   2. Default-enable it in migration 0017's game_rules.achievements
//      seed (or in a follow-up migration).
//   3. Call awardAchievement() from the right hook (match end, login, etc.)
//
// To retire one: leave the catalogue entry, mark it disabled in
// game_rules.achievements.enabled[key]=false. Earned rows stick around
// for posterity.

export interface AchievementMeta {
  key: string;
  title: string;
  description: string;
  category: 'streak' | 'milestone' | 'tier' | 'creator' | 'community' | 'mode';
}

export const CATALOGUE: ReadonlyArray<AchievementMeta> = [
  // ─── Streaks / lifetime counts ──────────────────────────────────────────
  {
    key: 'match_streak_7',
    title: 'Locked in',
    description: '7-day match streak',
    category: 'streak',
  },
  {
    key: 'match_streak_30',
    title: 'Devoted',
    description: '30-day match streak',
    category: 'streak',
  },
  {
    key: 'match_lifetime_100',
    title: 'Veteran',
    description: '100 lifetime matches',
    category: 'milestone',
  },
  {
    key: 'match_lifetime_1000',
    title: 'Hall of Beats',
    description: '1,000 lifetime matches',
    category: 'milestone',
  },
  // ─── Vote-receiver milestones ──────────────────────────────────────────
  {
    key: 'votes_lifetime_100',
    title: 'Crowd Pleaser',
    description: '100 lifetime votes received',
    category: 'milestone',
  },
  {
    key: 'daily_champion',
    title: 'Daily Champion',
    description: 'Topped a Daily Challenge',
    category: 'mode',
  },
  {
    key: 'weekly_pick',
    title: 'Weekly Pick',
    description: 'Top-voted of the week',
    category: 'mode',
  },
  // ─── Genre mastery (10 wins per genre) ─────────────────────────────────
  {
    key: 'genre_mastery_10',
    title: 'Genre Master',
    description: '10 wins in the same genre',
    category: 'mode',
  },
  // ─── Community contribution ────────────────────────────────────────────
  {
    key: 'active_listener_10',
    title: 'Active Listener',
    description: 'Voted on 10 matches',
    category: 'community',
  },
  {
    key: 'trusted_honor',
    title: 'Trusted',
    description: 'Honor 90+ for 30 consecutive days',
    category: 'community',
  },
  {
    key: 'honor_streak_90',
    title: 'Pillar',
    description: 'Honor 100 for 90 consecutive days',
    category: 'community',
  },
  // ─── Pack creator ──────────────────────────────────────────────────────
  {
    key: 'pack_creator_first',
    title: 'Pack Creator',
    description: 'First pack promoted to the pool',
    category: 'creator',
  },
  {
    key: 'pack_iconic_500',
    title: 'Iconic',
    description: 'A pack hit 500 plays',
    category: 'creator',
  },
  {
    key: 'pack_producers_producer_5',
    title: "Producer's Producer",
    description: 'Five packs in the pool',
    category: 'creator',
  },
  // ─── Tier achievements ────────────────────────────────────────────────
  { key: 'tier_silver', title: 'Silver', description: 'Reached Silver', category: 'tier' },
  { key: 'tier_gold', title: 'Gold', description: 'Reached Gold', category: 'tier' },
  { key: 'tier_plat', title: 'Platinum', description: 'Reached Platinum', category: 'tier' },
  { key: 'tier_diamond', title: 'Diamond', description: 'Reached Diamond', category: 'tier' },
  { key: 'tier_master', title: 'Master', description: 'Reached Master', category: 'tier' },
  {
    key: 'tier_grandmaster',
    title: 'Grandmaster',
    description: 'Reached Grandmaster (top 1%)',
    category: 'tier',
  },
  // ─── Season + tournament ──────────────────────────────────────────────
  {
    key: 'season_finalist_top10',
    title: 'Season Finalist',
    description: 'Finished a season in the top 10',
    category: 'milestone',
  },
  {
    key: 'remix_master_10',
    title: 'Remix Master',
    description: '10 Sample Flip wins',
    category: 'mode',
  },
  {
    key: 'remix_master_50',
    title: 'Master Remixer',
    description: '50 Sample Flip wins',
    category: 'mode',
  },
  {
    key: 'tournament_winner',
    title: 'Champion',
    description: 'Won a tournament',
    category: 'milestone',
  },
];

const BY_KEY = new Map(CATALOGUE.map((a) => [a.key, a]));

export function getAchievement(key: string): AchievementMeta | undefined {
  return BY_KEY.get(key);
}

export type AchievementKey = (typeof CATALOGUE)[number]['key'];
