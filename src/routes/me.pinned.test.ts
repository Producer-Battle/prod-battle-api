// Unit tests for pinned-tracks endpoint validation (perk #6).
//
// Tests the business rules: free users can't pin, paid users can pin up to 3
// submissions that belong to them.

import { describe, expect, it } from 'vitest';

// Pure business-rule helpers extracted inline (no HTTP layer needed).
// We replicate the guard logic from the PUT /me/pinned-tracks handler.

function validatePinnedRequest(
  submissionIds: string[],
  plan: 'free' | 'paid',
  ownedIds: Set<string>,
): { ok: true } | { ok: false; error: string; status: number } {
  if (submissionIds.length > 3) {
    return { ok: false, error: 'max_3_pinned', status: 400 };
  }

  if (submissionIds.length > 0 && plan !== 'paid') {
    return { ok: false, error: 'supporter_only', status: 402 };
  }

  const invalid = submissionIds.filter((id) => !ownedIds.has(id));
  if (invalid.length > 0) {
    return { ok: false, error: 'invalid_submissions', status: 400 };
  }

  return { ok: true };
}

const MY_SUB_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const MY_SUB_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const MY_SUB_C = 'cccccccc-0000-0000-0000-000000000003';
const MY_SUB_D = 'dddddddd-0000-0000-0000-000000000004';
const OTHER_SUB = 'eeeeeeee-0000-0000-0000-000000000005';
const myOwnedIds = new Set([MY_SUB_A, MY_SUB_B, MY_SUB_C, MY_SUB_D]);

describe('pinned tracks validation', () => {
  it('allows free user to unpin (empty array)', () => {
    const r = validatePinnedRequest([], 'free', myOwnedIds);
    expect(r.ok).toBe(true);
  });

  it('blocks free user from pinning any submissions', () => {
    const r = validatePinnedRequest([MY_SUB_A], 'free', myOwnedIds);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(402);
      expect(r.error).toBe('supporter_only');
    }
  });

  it('allows paid user to pin 1-3 owned submissions', () => {
    expect(validatePinnedRequest([MY_SUB_A], 'paid', myOwnedIds).ok).toBe(true);
    expect(validatePinnedRequest([MY_SUB_A, MY_SUB_B], 'paid', myOwnedIds).ok).toBe(true);
    expect(validatePinnedRequest([MY_SUB_A, MY_SUB_B, MY_SUB_C], 'paid', myOwnedIds).ok).toBe(true);
  });

  it('blocks paid user from pinning more than 3', () => {
    const r = validatePinnedRequest([MY_SUB_A, MY_SUB_B, MY_SUB_C, MY_SUB_D], 'paid', myOwnedIds);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('blocks paid user from pinning another user submission', () => {
    const r = validatePinnedRequest([MY_SUB_A, OTHER_SUB], 'paid', myOwnedIds);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toBe('invalid_submissions');
    }
  });
});
