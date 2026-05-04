// Unit tests for the weekly-tournament-scan helper functions.
// These are pure-JS and require no DB connection.

import { describe, expect, it } from 'vitest';
import { isoWeekNumber, nextSundayNoon } from './tick.js';

describe('nextSundayNoon', () => {
  it('from Monday returns the Sunday of the same week', () => {
    // 2026-04-27 is a Monday.
    const monday = new Date('2026-04-27T09:05:00Z');
    const result = nextSundayNoon(monday);
    expect(result.toISOString()).toBe('2026-05-03T12:00:00.000Z');
  });

  it('from Sunday returns next Sunday (not same day)', () => {
    // 2026-05-03 is a Sunday.
    const sunday = new Date('2026-05-03T08:00:00Z');
    const result = nextSundayNoon(sunday);
    expect(result.toISOString()).toBe('2026-05-10T12:00:00.000Z');
  });

  it('from Saturday returns the next day (Sunday)', () => {
    // 2026-05-02 is a Saturday.
    const saturday = new Date('2026-05-02T23:00:00Z');
    const result = nextSundayNoon(saturday);
    expect(result.toISOString()).toBe('2026-05-03T12:00:00.000Z');
  });

  it('result is always 12:00:00 UTC', () => {
    const d = new Date('2026-04-28T14:30:00Z'); // Tuesday
    const result = nextSundayNoon(d);
    expect(result.getUTCHours()).toBe(12);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
  });
});

describe('isoWeekNumber', () => {
  it('Jan 1 2026 is ISO week 1', () => {
    // 2026-01-01 is a Thursday.
    expect(isoWeekNumber(new Date('2026-01-01T00:00:00Z'))).toBe(1);
  });

  it('2026-04-27 is ISO week 18', () => {
    expect(isoWeekNumber(new Date('2026-04-27T00:00:00Z'))).toBe(18);
  });

  it('2026-12-28 is ISO week 53', () => {
    expect(isoWeekNumber(new Date('2026-12-28T00:00:00Z'))).toBe(53);
  });
});
