// Genre registry.
// MVP ships system genres: hip-hop/trap, house, phonk, hardstyle.
// A/B/C-tier genres (afro-house, melodic-techno, amapiano, DnB, dubstep,
// trance, techno, UK garage, future-bass, baile-funk) are added via admin panel,
// not hardcoded.

import type { GenreFormatConfig } from '../db/schema.js';

export type SystemGenreSeed = {
  slug: string;
  name: string;
  formatConfig: GenreFormatConfig;
};

export const MVP_SYSTEM_GENRES: readonly SystemGenreSeed[] = [
  {
    slug: 'hip-hop-trap',
    name: 'Hip-hop / trap beats',
    formatConfig: {
      submission: { maxSeconds: 90, fileTypes: ['audio/mpeg', 'audio/wav'] },
      vote: { model: 'community', weighted: false },
      phases: { submitSeconds: 600, revealSeconds: 180, voteSeconds: 180 },
    },
  },
  {
    slug: 'house',
    name: 'House (deep / tech / melodic)',
    formatConfig: {
      submission: { maxSeconds: 180, fileTypes: ['audio/mpeg', 'audio/wav'] },
      vote: { model: 'community', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 360, voteSeconds: 240 },
    },
  },
  {
    slug: 'phonk',
    name: 'Phonk (incl. drift phonk)',
    formatConfig: {
      submission: { maxSeconds: 60, fileTypes: ['audio/mpeg', 'audio/wav'] },
      vote: { model: 'community', weighted: false },
      phases: { submitSeconds: 600, revealSeconds: 120, voteSeconds: 180 },
    },
  },
  {
    slug: 'hardstyle',
    name: 'Hardstyle',
    formatConfig: {
      submission: { maxSeconds: 120, fileTypes: ['audio/mpeg', 'audio/wav'] },
      vote: { model: 'peer', weighted: true },
      phases: { submitSeconds: 900, revealSeconds: 240, voteSeconds: 240 },
    },
  },
] as const;
