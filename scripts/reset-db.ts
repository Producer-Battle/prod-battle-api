// Wipe the database back to "fresh install + genres seeded".
//
// Deletes every row in user-content tables (submissions → matches →
// match_players/teams → battle_phases → votes → follows → messages →
// genre_votes → sample_packs → users → auth tables). Genres are
// truncated and re-seeded at the end from MVP_SYSTEM_GENRES.
//
// Intentionally destructive. Only run when you actually want the DB
// wiped (dev, pre-launch, recovery).
//
//   pnpm db:reset
//
// The drizzle-kit migrations table is left intact so the next boot
// doesn't try to re-apply every migration.

import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';

async function main() {
  const d = db();

  // Delete-order-sensitive but TRUNCATE CASCADE handles FK dependencies
  // for us. Listing each table anyway so the output is informative.
  const tables = [
    'votes',
    'submission_likes',
    'submission_tags',
    'submissions',
    'battle_phases',
    'match_players',
    'match_teams',
    'matches',
    'genre_votes',
    'sample_packs',
    'follows',
    'ar_watchlist',
    'ar_applications',
    'messages',
    'admin_actions',
    'producer_profiles',
    'sessions',
    'accounts',
    'verifications',
    'users',
    'genres',
  ];
  console.log('[reset] truncating tables…');
  for (const t of tables) {
    console.log(`  TRUNCATE ${t}`);
    await d.execute(sql.raw(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`));
  }

  console.log('[reset] re-seeding system genres…');
  await import('./seed.js');
}

main().catch((err) => {
  console.error('[reset] failed:', err);
  process.exit(1);
});
