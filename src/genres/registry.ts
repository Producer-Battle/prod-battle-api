// System genre catalogue seeded on a fresh DB.
//
// Curated from what's actively being produced right now (2026 landscape:
// hip-hop/trap still the volume leader, amapiano + afro-house breaking
// mainstream, phonk + drill still hot on TikTok, DnB/dubstep on a bass-
// music resurgence, lo-fi owning the chill playlists). Keep this list
// tight — an operator can add more via POST /admin/genres once the DB
// is live.
//
// Each entry's format_config drives the match flow:
//   submission.maxSeconds  — duration cap per submission
//   vote.model             — 'community' | 'peer' | 'judge-panel'
//   phases.*               — submit / reveal / vote timers in seconds
//
// User-created genres (kind='user', createdBy=<uuid>) are independent
// of this list — they flow through POST /genres → community voting →
// promotion.

import type { GenreFormatConfig } from '../db/schema.js';

export type SystemGenreSeed = {
  slug: string;
  name: string;
  formatConfig: GenreFormatConfig;
};

// Durations roughly matched to each style's typical flip:
//   short bangers (phonk, drill, trap)  → 5-min submit
//   arrangement-heavy (house, DnB)      → 10–15-min submit
//   dense sound design (dubstep, hard)  → 10-min submit
const mp3wav = ['audio/mpeg', 'audio/wav'];
const short = { submission: { maxSeconds: 60, fileTypes: mp3wav } } as const;
const medium = { submission: { maxSeconds: 120, fileTypes: mp3wav } } as const;
const long = { submission: { maxSeconds: 180, fileTypes: mp3wav } } as const;

export const MVP_SYSTEM_GENRES: readonly SystemGenreSeed[] = [
  {
    slug: 'hip-hop-trap',
    name: 'Hip-hop / Trap',
    formatConfig: {
      ...medium,
      vote: { model: 'community', weighted: false },
      phases: { submitSeconds: 600, revealSeconds: 180, voteSeconds: 180 },
    },
  },
  {
    slug: 'phonk',
    name: 'Phonk (incl. drift phonk)',
    formatConfig: {
      ...short,
      vote: { model: 'community', weighted: false },
      phases: { submitSeconds: 600, revealSeconds: 120, voteSeconds: 180 },
    },
  },
  {
    slug: 'house',
    name: 'House (deep / tech / melodic)',
    formatConfig: {
      ...long,
      vote: { model: 'community', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 360, voteSeconds: 240 },
    },
  },
  {
    slug: 'amapiano',
    name: 'Amapiano',
    formatConfig: {
      ...long,
      vote: { model: 'community', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 360, voteSeconds: 240 },
    },
  },
  {
    slug: 'afro-house',
    name: 'Afro-house',
    formatConfig: {
      ...long,
      vote: { model: 'community', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 360, voteSeconds: 240 },
    },
  },
  {
    slug: 'drum-and-bass',
    name: 'Drum & Bass',
    formatConfig: {
      ...medium,
      vote: { model: 'community', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 240, voteSeconds: 240 },
    },
  },
  {
    slug: 'dubstep',
    name: 'Dubstep / Riddim',
    formatConfig: {
      ...medium,
      vote: { model: 'community', weighted: true },
      phases: { submitSeconds: 600, revealSeconds: 180, voteSeconds: 240 },
    },
  },
  {
    slug: 'techno',
    name: 'Techno (peak-time / melodic)',
    formatConfig: {
      ...long,
      vote: { model: 'community', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 360, voteSeconds: 240 },
    },
  },
  {
    slug: 'hardstyle',
    name: 'Hardstyle',
    formatConfig: {
      ...medium,
      vote: { model: 'peer', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 240, voteSeconds: 240 },
    },
  },
  {
    slug: 'lo-fi',
    name: 'Lo-fi hip-hop',
    formatConfig: {
      ...short,
      vote: { model: 'community', weighted: false },
      phases: { submitSeconds: 600, revealSeconds: 120, voteSeconds: 180 },
    },
  },
];
