import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Enums
 * ──────────────────────────────────────────────────────────────────────────
 */

export const userRole = pgEnum('user_role', ['producer', 'ar', 'admin']);

export const arStatus = pgEnum('ar_status', ['pending', 'approved', 'rejected']);

export const genreKind = pgEnum('genre_kind', ['system', 'user']);
export const genreStatus = pgEnum('genre_status', ['active', 'archived', 'proposed']);

export const matchMode = pgEnum('match_mode', [
  'quickplay',
  'ranked',
  'private',
  'tournament',
  'practice',
]);

export const matchStatus = pgEnum('match_status', [
  'lobby',
  'submit',
  'reveal',
  'vote',
  'results',
  'cancelled',
]);

export const matchPhase = pgEnum('match_phase', [
  'lobby',
  'submit',
  'reveal',
  'vote',
  'results',
]);

export const samplePackKind = pgEnum('sample_pack_kind', ['uploaded', 'generated', 'pool']);

export const sampleMode = pgEnum('sample_mode', ['none', 'generated', 'uploaded']);

/*
 * Users + roles
 * ──────────────────────────────────────────────────────────────────────────
 */

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    handle: text().notNull(),
    role: userRole().notNull().default('producer'),
    avatarUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_handle_unique').on(t.handle),
  ],
);

export const producerProfiles = pgTable('producer_profiles', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  bio: text(),
  location: text(),
  openToAr: boolean().notNull().default(true),
  socialLinks: jsonb().$type<Record<string, string>>().notNull().default({}),
});

export const arApplications = pgTable('ar_applications', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  labelName: text().notNull(),
  evidence: text().notNull(),
  status: arStatus().notNull().default('pending'),
  reviewerId: uuid().references(() => users.id, { onDelete: 'set null' }),
  reviewNote: text(),
  reviewedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/*
 * Genres — two tiers: system (admin-curated, has format_config) and user (UGC tag).
 * format_config defines the battle shape when this genre is used for ranked/quickplay:
 *   { submission: { maxSeconds, fileTypes[] },
 *     vote: { model: 'community'|'peer'|'judge-panel', weighted: bool },
 *     phases: { submitSeconds, revealSeconds, voteSeconds } }
 * User genres default format_config = null and can only be used in private rooms or as tags.
 * ──────────────────────────────────────────────────────────────────────────
 */

export type GenreFormatConfig = {
  submission: {
    maxSeconds: number;
    fileTypes: string[];
  };
  vote: {
    model: 'community' | 'peer' | 'judge-panel';
    weighted: boolean;
  };
  phases: {
    submitSeconds: number;
    revealSeconds: number;
    voteSeconds: number;
  };
};

export const genres = pgTable(
  'genres',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    kind: genreKind().notNull(),
    parentId: uuid().references((): any => genres.id, { onDelete: 'set null' }),
    formatConfig: jsonb().$type<GenreFormatConfig | null>(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    status: genreStatus().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('genres_slug_unique').on(t.slug)],
);

/*
 * Sample packs — the pool of stems a match can pull from when
 * sample_mode = 'generated' or 'uploaded'.
 *
 * kind='pool':     curated library we seed per genre; drawn from at quickplay time.
 * kind='generated': created per-match by picking stems from the relevant pool.
 * kind='uploaded':  zip uploaded by a private-room host.
 *
 * `samples` JSONB shape:
 *   [{ stemType: 'kick' | 'snare' | 'hihat' | '808' | 'clap' | ..., name, url }]
 * ──────────────────────────────────────────────────────────────────────────
 */

export type SamplePackItem = {
  stemType: string;
  name: string;
  url: string;
};

export const samplePacks = pgTable('sample_packs', {
  id: uuid().primaryKey().defaultRandom(),
  genreId: uuid()
    .notNull()
    .references(() => genres.id, { onDelete: 'cascade' }),
  kind: samplePackKind().notNull(),
  name: text().notNull(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  samples: jsonb().$type<SamplePackItem[]>().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/*
 * Matches — solo practice, 1v1 duels, team battles up to 5v5, FFA up to 8.
 * Invariant: team_size * team_count <= 10.
 *   Practice → team_size=1, team_count=1   (solo)
 *   1v1      → team_size=1, team_count=2   (2 players)
 *   2v2      → team_size=2, team_count=2   (4 players)
 *   …up to 5v5 → team_size=5, team_count=2 (10 players)
 *   FFA      → team_size=1, team_count=N in 3..8 (everyone solo, "1v1v1…")
 *
 * Genres: every match has a primary_genre_id. Private rooms can additionally
 * allow a rotation pool via `allowed_genre_ids` (host-selected). Ranked/quickplay
 * uses primary_genre_id only and requires kind='system'.
 *
 * Sample mode:
 *   'none'       — bring your own full track (legacy "beat battle" flow)
 *   'generated'  — platform picks a random pack from the genre pool and
 *                  all producers in the room get the same stems to flip
 *   'uploaded'   — host provided a ZIP, all producers get those exact stems
 * ──────────────────────────────────────────────────────────────────────────
 */

export const matches = pgTable(
  'matches',
  {
    id: uuid().primaryKey().defaultRandom(),
    mode: matchMode().notNull(),
    status: matchStatus().notNull().default('lobby'),
    roomCode: text(),
    hostId: uuid().references(() => users.id, { onDelete: 'set null' }),

    // Team layout
    teamSize: integer().notNull(),
    teamCount: integer().notNull(),

    // Genre selection
    primaryGenreId: uuid()
      .notNull()
      .references(() => genres.id, { onDelete: 'restrict' }),
    allowedGenreIds: uuid().array().notNull().default(sql`ARRAY[]::uuid[]`),

    // Submission-phase duration: how long producers have to make a track.
    // Null means "fall back to the genre's format_config.phases.submitSeconds".
    // Private rooms pick from a preset list enforced at the API (and via CHECK below):
    //   60, 120, 300, 600, 1200, 1800, 3000, 3600 seconds
    //   (= 1, 2, 5, 10, 20, 30, 50, 60 minutes).
    // Other modes get opinionated per-mode defaults (see matchmaking/defaults.ts).
    submitSeconds: integer(),

    // Sample pack configuration
    sampleMode: sampleMode().notNull().default('none'),
    samplePackId: uuid().references(() => samplePacks.id, { onDelete: 'set null' }),

    // Lifecycle
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('matches_room_code_unique').on(t.roomCode),
    check('matches_team_size_range', sql`${t.teamSize} between 1 and 5`),
    check('matches_team_count_range', sql`${t.teamCount} between 1 and 8`),
    check('matches_total_players_max_10', sql`${t.teamSize} * ${t.teamCount} <= 10`),
    check(
      'matches_submit_seconds_range',
      sql`${t.submitSeconds} IS NULL OR (${t.submitSeconds} BETWEEN 30 AND 7200)`,
    ),
  ],
);

export const matchTeams = pgTable('match_teams', {
  id: uuid().primaryKey().defaultRandom(),
  matchId: uuid()
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  seat: integer().notNull(), // 0..team_count-1
  name: text(),
  finalRank: integer(),
});

export const matchPlayers = pgTable(
  'match_players',
  {
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    teamId: uuid().references(() => matchTeams.id, { onDelete: 'set null' }),
    isSpectator: boolean().notNull().default(false),
    finalRank: integer(),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.userId] })],
);

/*
 * Battle phases — drives the tick worker.
 * The tick worker polls rows WHERE transitions_at <= now() with FOR UPDATE SKIP LOCKED,
 * advances current_phase, and broadcasts via Redis.
 * ──────────────────────────────────────────────────────────────────────────
 */

export const battlePhases = pgTable('battle_phases', {
  matchId: uuid()
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  currentPhase: matchPhase().notNull().default('lobby'),
  transitionsAt: timestamp({ withTimezone: true }).notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/*
 * Submissions — catalog layer. Every match round produces persistent content.
 * ──────────────────────────────────────────────────────────────────────────
 */

export const submissions = pgTable('submissions', {
  id: uuid().primaryKey().defaultRandom(),
  matchId: uuid()
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  genreId: uuid()
    .notNull()
    .references(() => genres.id, { onDelete: 'restrict' }),
  audioUrl: text().notNull(),
  waveformUrl: text(),
  durationSec: integer(),
  title: text(),
  description: text(),
  finalRank: integer(),
  score: numeric({ precision: 10, scale: 3 }).notNull().default('0'),
  plays: integer().notNull().default(0),
  likes: integer().notNull().default(0),
  isPublic: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const submissionLikes = pgTable(
  'submission_likes',
  {
    submissionId: uuid()
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.userId] })],
);

export const submissionTags = pgTable(
  'submission_tags',
  {
    submissionId: uuid()
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    genreId: uuid()
      .notNull()
      .references(() => genres.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.genreId] })],
);

/*
 * Votes — one row per (match, voter, submission). weight lets us promote
 * verified-producer votes later.
 * ──────────────────────────────────────────────────────────────────────────
 */

export const votes = pgTable(
  'votes',
  {
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    voterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submissionId: uuid()
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    weight: numeric({ precision: 6, scale: 3 }).notNull().default('1'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.voterId, t.submissionId] })],
);

/*
 * Ranking + seasons — Glicko per (user, genre, season).
 * ──────────────────────────────────────────────────────────────────────────
 */

export const seasons = pgTable(
  'seasons',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('seasons_slug_unique').on(t.slug)],
);

export const rankings = pgTable(
  'rankings',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    genreId: uuid()
      .notNull()
      .references(() => genres.id, { onDelete: 'cascade' }),
    seasonId: uuid()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    glickoRating: numeric({ precision: 10, scale: 3 }).notNull().default('1500'),
    glickoRd: numeric({ precision: 10, scale: 3 }).notNull().default('350'),
    wins: integer().notNull().default(0),
    losses: integer().notNull().default(0),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.genreId, t.seasonId] })],
);

/*
 * Social + A&R
 * ──────────────────────────────────────────────────────────────────────────
 */

export const follows = pgTable(
  'follows',
  {
    followerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followedId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followedId] })],
);

export const arWatchlist = pgTable(
  'ar_watchlist',
  {
    arUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    producerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    note: text(),
    addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.arUserId, t.producerId] })],
);

export const messages = pgTable('messages', {
  id: uuid().primaryKey().defaultRandom(),
  senderId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  recipientId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  body: text().notNull(),
  readAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/*
 * Admin + flags
 * ──────────────────────────────────────────────────────────────────────────
 */

export const adminActions = pgTable('admin_actions', {
  id: uuid().primaryKey().defaultRandom(),
  adminId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  action: text().notNull(),
  targetType: text().notNull(),
  targetId: text().notNull(),
  reason: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const featureFlags = pgTable('feature_flags', {
  key: text().primaryKey(),
  enabled: boolean().notNull().default(false),
  rolloutPct: integer().notNull().default(0),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
