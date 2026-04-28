// Unit tests for submission download auth + ownership checks (perk #5).
//
// Tests the pure guard logic: plan check, ownership check.

import { describe, expect, it } from 'vitest';

// Pure guard logic extracted from the download handler.
function checkDownloadAccess(
  userPlan: 'free' | 'paid',
  userId: string,
  submission: { userId: string } | null,
): { ok: true } | { ok: false; error: string; status: number } {
  if (userPlan !== 'paid') {
    return { ok: false, error: 'supporter_only', status: 402 };
  }
  if (!submission) {
    return { ok: false, error: 'not_found', status: 404 };
  }
  if (submission.userId !== userId) {
    return { ok: false, error: 'forbidden', status: 403 };
  }
  return { ok: true };
}

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('submission download access', () => {
  it('blocks free users regardless of ownership', () => {
    const r = checkDownloadAccess('free', USER_A, { userId: USER_A });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(402);
  });

  it('blocks paid user downloading someone elses submission', () => {
    const r = checkDownloadAccess('paid', USER_A, { userId: USER_B });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('returns 404 when submission does not exist', () => {
    const r = checkDownloadAccess('paid', USER_A, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('allows paid user downloading their own submission', () => {
    const r = checkDownloadAccess('paid', USER_A, { userId: USER_A });
    expect(r.ok).toBe(true);
  });
});
