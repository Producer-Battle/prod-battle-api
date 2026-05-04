// E2E test for weeklyTournamentScan().
//
// Self-healing guarantee: the scan must create a weekly tournament for the
// upcoming Sunday slot regardless of what day/time the call happens on
// (deploys, restarts, leader handoffs all used to silently skip a week
// because the old code only fired during a 30-min Monday window).
// Idempotency: running the scan twice in the same week creates exactly
// one tournament.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { weeklyTournamentScan } from '../../realtime/tick.js';
import { resetMatchState, seedTestFixtures } from '../seed.js';

// The scan has a 30-second internal throttle keyed off Date.now(). The
// `lastWeeklyTournamentScanAt` module variable persists across tests in the
// same process, so each call must present a timestamp strictly greater
// than every prior one (including the explicit Saturday 2026-05-09 mock
// in the day-of-week test). Use a far-future monotonically increasing
// epoch so we always clear the throttle.
let scanEpoch = new Date('2030-01-01T00:00:00Z').getTime();
function withFreshScan<T>(fn: () => Promise<T>): Promise<T> {
  scanEpoch += 60_000;
  const epoch = scanEpoch;
  const spy = vi.spyOn(Date, 'now').mockReturnValue(epoch);
  return fn().finally(() => spy.mockRestore());
}

async function clearAutoTournaments(): Promise<void> {
  const d = db();
  await d.execute(sql`DELETE FROM tournaments WHERE auto_created = true`);
}

async function countAutoTournaments(): Promise<number> {
  const d = db();
  const rows = (await d.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM tournaments WHERE auto_created = true`,
  )) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

describe('weeklyTournamentScan', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
    await clearAutoTournaments();
  });

  it('creates a weekly tournament when none exists for the upcoming Sunday', async () => {
    expect(await countAutoTournaments()).toBe(0);
    await withFreshScan(() => weeklyTournamentScan());
    expect(await countAutoTournaments()).toBe(1);
  });

  it('is idempotent: a second scan in the same week does not double-insert', async () => {
    await withFreshScan(() => weeklyTournamentScan());
    expect(await countAutoTournaments()).toBe(1);
    await withFreshScan(() => weeklyTournamentScan());
    expect(await countAutoTournaments()).toBe(1);
  });

  it('runs on any day of the week (no Monday-09:00 gate)', async () => {
    // The old code only fired Monday 09:00-09:30 UTC. Verify a Saturday
    // call still creates one - i.e. the scan self-heals a missed week.
    // Use a saturday that's strictly later than the throttle's last seen
    // epoch so the throttle doesn't block this call.
    scanEpoch += 7 * 86_400_000; // jump a full week ahead
    // Round to the next Saturday so the assertion is meaningful.
    const reference = new Date(scanEpoch);
    const daysUntilSat = (6 - reference.getUTCDay() + 7) % 7 || 7;
    const saturday = Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate() + daysUntilSat,
      15,
      0,
      0,
    );
    scanEpoch = saturday;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(saturday);
    try {
      expect(new Date(saturday).getUTCDay()).toBe(6); // sanity: Saturday
      await weeklyTournamentScan();
    } finally {
      spy.mockRestore();
    }
    expect(await countAutoTournaments()).toBe(1);
  });

  it('inserts a row with auto_created=true, max_entrants=16, and a valid genre', async () => {
    await withFreshScan(() => weeklyTournamentScan());

    const rows = (await db().execute<{
      auto_created: boolean;
      max_entrants: number;
      submit_seconds_override: number;
      starts_at: string;
      genre_id: string;
    }>(
      sql`SELECT auto_created, max_entrants, submit_seconds_override, starts_at, genre_id
            FROM tournaments WHERE auto_created = true LIMIT 1`,
    )) as Array<{
      auto_created: boolean;
      max_entrants: number;
      submit_seconds_override: number;
      starts_at: string;
      genre_id: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.auto_created).toBe(true);
    expect(rows[0]?.max_entrants).toBe(16);
    expect([600, 1800, 3600]).toContain(Number(rows[0]?.submit_seconds_override));
    expect(rows[0]?.genre_id).toBeTruthy();
    // starts_at must be a Sunday at 12:00 UTC.
    const startsAt = new Date(rows[0]?.starts_at ?? '');
    expect(startsAt.getUTCDay()).toBe(0);
    expect(startsAt.getUTCHours()).toBe(12);
    expect(startsAt.getUTCMinutes()).toBe(0);
  });
});
