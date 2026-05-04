// Regression test: Drizzle's migrate() uses the `when` (folderMillis) field
// from _journal.json to decide which migrations to run. It fetches the single
// most-recently-applied row (by created_at DESC LIMIT 1) and skips any
// migration whose folderMillis <= that value. If a new migration is given a
// `when` that is older than the previous entry, Drizzle silently skips it
// forever - exactly what happened with 0032_tournament_showcase, which was
// timestamped 2025-05-05 (real-world time) while 0031_match_chat used a
// synthetic future timestamp. This test catches that class of bug.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

describe('migration journal', () => {
  const journalPath = resolve(
    import.meta.dirname ?? __dirname,
    '../../db/migrations/meta/_journal.json',
  );
  const journal: Journal = JSON.parse(readFileSync(journalPath, 'utf-8'));

  it('entries are ordered by idx', () => {
    for (let i = 0; i < journal.entries.length; i++) {
      expect(journal.entries[i]?.idx).toBe(i);
    }
  });

  it('when timestamps are strictly monotonically increasing', () => {
    // Drizzle compares lastApplied.created_at < migration.folderMillis.
    // If any entry has a when <= its predecessor, Drizzle will skip it
    // (and all later entries whose when also falls below the high-water mark).
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const curr = journal.entries[i];
      if (!prev || !curr) continue;
      expect(curr.when).toBeGreaterThan(prev.when);
    }
  });

  it('all referenced SQL files exist on disk', async () => {
    const { existsSync } = await import('node:fs');
    const migrationsDir = resolve(import.meta.dirname ?? __dirname, '../../db/migrations');
    for (const entry of journal.entries) {
      const sqlPath = resolve(migrationsDir, `${entry.tag}.sql`);
      expect(existsSync(sqlPath), `missing SQL file for ${entry.tag}`).toBe(true);
    }
  });
});
