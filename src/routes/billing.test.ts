// Unit tests for the Mollie billing webhook handler helpers.
//
// Strategy: mock the Mollie API client and the Drizzle DB client so these
// tests run without any external services. We verify that:
//   - applyPlanFromPayment sets plan='paid' when status='paid'.
//   - applyPlanFromPayment is a no-op for non-paid statuses.
//   - applyPlanFromSubscriptionCancel sets plan='free'.
//
// The route handlers themselves are covered at a higher level by the
// /billing/checkout and /billing/webhook endpoint integration tests (not
// yet written - those require a real DB and are e2e tests).

import { PaymentStatus } from '@mollie/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Minimal DB mock ─────────────────────────────────────────────────────────
//
// Captures the last update() call so we can assert on plan transitions.

let lastUpdate: { plan?: string; mollieCustomerId?: string } | null = null;

vi.mock('../db/client.js', () => ({
  db: () => ({
    update: (_table: unknown) => ({
      set: (values: { plan?: string }) => {
        lastUpdate = values;
        return {
          where: () => Promise.resolve([]),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ mollieCustomerId: null }]),
        }),
      }),
    }),
  }),
}));

// Partially mock the schema - only override what we need, keep all real exports.
vi.mock('../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema.js')>();
  return { ...actual };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => `${String(_col)}=${String(_val)}`),
  sql: vi.fn(),
}));

vi.mock('../env.js', () => ({
  env: {
    MOLLIE_API_KEY: 'test_fake_key',
    AUTH_BASE_URL: 'https://api.prodbattle.com',
    WEB_ORIGIN: 'https://prodbattle.com',
  },
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('applyPlanFromPayment', () => {
  beforeEach(() => {
    lastUpdate = null;
  });

  it('sets plan=paid when payment status is paid', async () => {
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({
          status: PaymentStatus.paid,
          customerId: 'cst_abc123',
        }),
      },
    };

    // Dynamic import to pick up the mocks set above.
    const { applyPlanFromPayment } = await import('./billing.js');
    const result = await applyPlanFromPayment(
      mockMollie as unknown as ReturnType<typeof import('@mollie/api-client').createMollieClient>,
      'tr_paid123',
    );

    expect(result).toBe('paid');
    expect(lastUpdate).toMatchObject({ plan: 'paid' });
  });

  it('returns no_change when payment status is not paid (cancelled)', async () => {
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({
          status: PaymentStatus.canceled,
          customerId: 'cst_abc123',
        }),
      },
    };

    const { applyPlanFromPayment } = await import('./billing.js');
    const result = await applyPlanFromPayment(
      mockMollie as unknown as ReturnType<typeof import('@mollie/api-client').createMollieClient>,
      'tr_canceled456',
    );

    expect(result).toBe('no_change');
    expect(lastUpdate).toBeNull();
  });

  it('returns not_found when payment has no customerId', async () => {
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({
          status: PaymentStatus.paid,
          customerId: undefined,
        }),
      },
    };

    const { applyPlanFromPayment } = await import('./billing.js');
    const result = await applyPlanFromPayment(
      mockMollie as unknown as ReturnType<typeof import('@mollie/api-client').createMollieClient>,
      'tr_nocustomer',
    );

    expect(result).toBe('not_found');
    expect(lastUpdate).toBeNull();
  });

  it('returns no_change when payment status is expired', async () => {
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({
          status: PaymentStatus.expired,
          customerId: 'cst_expiredcustomer',
        }),
      },
    };

    const { applyPlanFromPayment } = await import('./billing.js');
    const result = await applyPlanFromPayment(
      mockMollie as unknown as ReturnType<typeof import('@mollie/api-client').createMollieClient>,
      'tr_expired789',
    );

    expect(result).toBe('no_change');
    expect(lastUpdate).toBeNull();
  });
});

describe('applyPlanFromSubscriptionCancel', () => {
  beforeEach(() => {
    lastUpdate = null;
  });

  it('sets plan=free for the given Mollie customer id', async () => {
    const { applyPlanFromSubscriptionCancel } = await import('./billing.js');
    await applyPlanFromSubscriptionCancel('cst_sub_cancel');

    expect(lastUpdate).toMatchObject({ plan: 'free' });
  });
});
