// Per-mode defaults for match configuration.
// Private rooms let the host pick from PRIVATE_SUBMIT_SECONDS_PRESETS.
// Other modes use opinionated defaults that "feel right" for the mode.

export const PRIVATE_SUBMIT_SECONDS_PRESETS = [
  60, // 1 min - speedrun
  120, // 2 min
  300, // 5 min
  600, // 10 min
  1200, // 20 min
  1800, // 30 min
  3000, // 50 min
  3600, // 60 min - the deep-work option
] as const;

export type MatchMode = 'quickplay' | 'ranked' | 'private' | 'tournament' | 'practice';

// Submission-phase duration (seconds) used when a match row has
// `submit_seconds = NULL`. Picked to fit each mode's vibe:
//   quickplay  - fast, casual; drop a loop and move on
//   ranked     - more deliberate but still snappy
//   tournament - production round; longer, more polished submissions
//   practice   - relaxed, no pressure
export const SUBMIT_SECONDS_DEFAULT: Record<MatchMode, number> = {
  quickplay: 300, // 5 min
  ranked: 600, // 10 min
  private: 600, // fallback if host didn't pick (shouldn't happen)
  tournament: 1800, // 30 min
  practice: 900, // 15 min
};

// Team sizes each mode allows. Private = everything. Others are fixed.
export const ALLOWED_TEAM_LAYOUTS: Record<
  MatchMode,
  ReadonlyArray<{ teamSize: number; teamCount: number; label: string }>
> = {
  quickplay: [{ teamSize: 1, teamCount: 2, label: '1v1' }],
  ranked: [
    { teamSize: 1, teamCount: 2, label: '1v1' },
    { teamSize: 2, teamCount: 2, label: '2v2' },
  ],
  private: [
    { teamSize: 1, teamCount: 2, label: '1v1' },
    { teamSize: 2, teamCount: 2, label: '2v2' },
    { teamSize: 3, teamCount: 2, label: '3v3' },
    { teamSize: 4, teamCount: 2, label: '4v4' },
    { teamSize: 5, teamCount: 2, label: '5v5' },
    { teamSize: 1, teamCount: 3, label: 'FFA-3' },
    { teamSize: 1, teamCount: 4, label: 'FFA-4' },
    { teamSize: 1, teamCount: 5, label: 'FFA-5' },
    { teamSize: 1, teamCount: 6, label: 'FFA-6' },
    { teamSize: 1, teamCount: 7, label: 'FFA-7' },
    { teamSize: 1, teamCount: 8, label: 'FFA-8' },
  ],
  tournament: [
    { teamSize: 1, teamCount: 2, label: '1v1' },
    { teamSize: 2, teamCount: 2, label: '2v2' },
  ],
  practice: [{ teamSize: 1, teamCount: 1, label: 'solo' }],
};

// Sample mode options per match mode.
// Quickplay/ranked always generate; private lets the host choose.
export const DEFAULT_SAMPLE_MODE: Record<MatchMode, 'none' | 'generated' | 'uploaded'> = {
  quickplay: 'generated',
  ranked: 'generated',
  private: 'generated',
  tournament: 'generated',
  practice: 'none',
};

// Stem set expected for each genre's generated pack. Used by the pool
// seeder and by the match-start generator to pick one of each stem type.
export const GENRE_STEMS: Record<string, readonly string[]> = {
  'hip-hop-trap': ['kick', 'snare', 'hihat', '808', 'clap', 'openhat', 'perc', 'fx'],
  house: ['kick', 'snare', 'hihat', 'bass', 'lead', 'pad', 'clap', 'fx'],
  phonk: ['kick', 'snare', 'hihat', 'cowbell', '808', 'vocal', 'fx'],
  hardstyle: ['kick', 'screech', 'zap', 'reverse', 'vocal'],
};
