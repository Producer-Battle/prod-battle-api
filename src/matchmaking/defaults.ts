// Per-mode defaults for match configuration.
// Private rooms let the host pick from PRIVATE_SUBMIT_SECONDS_PRESETS.
// Other modes use opinionated defaults that "feel right" for the mode.

export const PRIVATE_SUBMIT_SECONDS_PRESETS = [
  300, // 5 min - shortest allowed
  600, // 10 min
  1200, // 20 min
  1800, // 30 min
  3000, // 50 min
  3600, // 60 min - the deep-work option
] as const;

export type MatchMode =
  | 'quickplay'
  | 'ranked'
  | 'private'
  | 'tournament'
  | 'practice'
  | 'flip'
  | 'daily';

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
  flip: 600, // 10 min - enough to arrange a loop, not so long it drags
  // Daily matches have no timed phase. NULL is stored in DB; this fallback
  // is used by GET /matches/:code submitSeconds response only.
  daily: 86400,
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
  // Sample Flip is always FFA - everyone flips the same source, community vote.
  flip: [
    { teamSize: 1, teamCount: 3, label: 'FFA-3' },
    { teamSize: 1, teamCount: 4, label: 'FFA-4' },
    { teamSize: 1, teamCount: 8, label: 'FFA-8' },
  ],
  // Daily matches use teamSize=1/teamCount=1 to satisfy DB constraints.
  // The 20-submitter cap is pure application logic, not a team-layout concern.
  daily: [{ teamSize: 1, teamCount: 1, label: 'Daily' }],
};

// Sample mode options per match mode.
// Quickplay/ranked always generate; private lets the host choose.
export const DEFAULT_SAMPLE_MODE: Record<MatchMode, 'none' | 'generated' | 'uploaded'> = {
  quickplay: 'generated',
  ranked: 'generated',
  private: 'generated',
  tournament: 'generated',
  practice: 'none',
  // Flip matches also get a generated drum pack alongside the main flip
  // source so producers have drums/bass to build around the loop.
  flip: 'generated',
  // Daily challenge uses a pool pack chosen deterministically from the date hash.
  // The pack is resolved at match creation, not generated on the fly.
  daily: 'generated',
};

// Stem set expected for each genre's generated pack. Used by the pool
// seeder and by the match-start generator to pick one of each stem type.
export const GENRE_STEMS: Record<string, readonly string[]> = {
  'hip-hop-trap': ['kick', 'snare', 'hihat', '808', 'clap', 'openhat', 'perc', 'fx'],
  phonk: ['kick', 'snare', 'hihat', 'cowbell', '808', 'vocal', 'fx'],
  house: ['kick', 'snare', 'hihat', 'bass', 'lead', 'pad', 'clap', 'fx'],
  amapiano: ['kick', 'snare', 'hihat', 'bass', 'pad', 'lead', 'perc', 'vocal'],
  'afro-house': ['kick', 'snare', 'hihat', 'bass', 'perc', 'pad', 'vocal', 'fx'],
  'drum-and-bass': ['kick', 'snare', 'hihat', 'bass', 'lead', 'pad', 'fx'],
  dubstep: ['kick', 'snare', 'bass', 'lead', 'fx'],
  techno: ['kick', 'snare', 'hihat', 'bass', 'lead', 'pad', 'perc', 'fx'],
  hardstyle: ['kick', 'screech', 'zap', 'reverse', 'vocal'],
  'lo-fi': ['kick', 'snare', 'hihat', 'bass', 'pad', 'vocal', 'fx'],
};
