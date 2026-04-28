// Unit tests for the sample-pack upload quota check (perk #3).
//
// Tests the pure checkPackQuota() function without a real DB. We mock the
// Drizzle client to return controlled pack counts and assert the quota
// logic for both free and paid users.

import { describe, expect, it, vi } from 'vitest';

// ─── DB mock ─────────────────────────────────────────────────────────────────

let mockPackCount = 0;

vi.mock('../db/client.js', () => ({
  db: () => ({
    execute: () => Promise.resolve([{ n: String(mockPackCount) }]),
  }),
}));

vi.mock('../db/schema.js', () => ({
  samplePacks: { createdBy: 'created_by', kind: 'kind' },
}));

vi.mock('drizzle-orm', () => ({
  sql: new Proxy((strings: TemplateStringsArray, ..._values: unknown[]) => strings.join('?'), {
    get: (_t, k) => (k === 'raw' ? () => '' : undefined),
  }),
  eq: () => 'eq',
  and: () => 'and',
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('checkPackQuota', () => {
  it('allows free user with 0 packs (under quota of 1)', async () => {
    mockPackCount = 0;
    const { checkPackQuota } = await import('./user-packs.js');
    const result = await checkPackQuota('user-1', 'free');
    expect(result.allowed).toBe(true);
    expect(result.quota).toBe(1);
    expect(result.current).toBe(0);
  });

  it('blocks free user who already has 1 pack (at quota)', async () => {
    mockPackCount = 1;
    const { checkPackQuota } = await import('./user-packs.js');
    const result = await checkPackQuota('user-1', 'free');
    expect(result.allowed).toBe(false);
    expect(result.quota).toBe(1);
    expect(result.current).toBe(1);
  });

  it('allows paid user with 9 packs (under quota of 10)', async () => {
    mockPackCount = 9;
    const { checkPackQuota } = await import('./user-packs.js');
    const result = await checkPackQuota('user-2', 'paid');
    expect(result.allowed).toBe(true);
    expect(result.quota).toBe(10);
    expect(result.current).toBe(9);
  });

  it('blocks paid user who already has 10 packs (at quota)', async () => {
    mockPackCount = 10;
    const { checkPackQuota } = await import('./user-packs.js');
    const result = await checkPackQuota('user-2', 'paid');
    expect(result.allowed).toBe(false);
    expect(result.quota).toBe(10);
    expect(result.current).toBe(10);
  });
});
