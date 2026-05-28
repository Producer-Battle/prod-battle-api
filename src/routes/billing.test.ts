// Unit tests for the Mollie recurring-billing helpers.
//
// Strategy: mock the Mollie API client and the Drizzle DB client so these
// tests run without external services. We verify:
//   - processPaymentWebhook on a paid "first" payment creates a subscription
//     and sets plan=paid + subscriptionStatus=active + planExpiresAt.
//   - processPaymentWebhook on a paid "recurring" payment extends access.
//   - non-paid statuses and unknown sequences are no-ops.
//   - applyPlanFromSubscriptionCancel demotes to free.

import { PaymentStatus } from '@mollie/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the last update().set() values so we can assert plan transitions.
let lastUpdate: Record<string, unknown> | null = null;

vi.mock('../db/client.js', () => ({
  db: () => ({
    update: (_table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        lastUpdate = values;
        return { where: () => ({ returning: () => Promise.resolve([{ id: 'user_1' }]) }) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ mollieCustomerId: null }]) }),
      }),
    }),
  }),
}));

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

// Discord role-sync is fire-and-forget; stub it so it never reaches a network.
vi.mock('../discord/role-sync.js', () => ({
  syncSupporterRole: vi.fn(() => Promise.resolve()),
}));

type MollieMock = Parameters<typeof import('./billing.js').processPaymentWebhook>[0];

describe('processPaymentWebhook - first payment', () => {
  beforeEach(() => {
    lastUpdate = null;
  });

  it('creates a subscription and sets plan=paid on a paid first payment', async () => {
    const createSub = vi.fn().mockResolvedValue({ id: 'sub_abc' });
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({
          status: PaymentStatus.paid,
          customerId: 'cst_abc',
          sequenceType: 'first',
          metadata: { interval: 'monthly' },
        }),
      },
      customerSubscriptions: { create: createSub },
    };

    const { processPaymentWebhook } = await import('./billing.js');
    const result = await processPaymentWebhook(mockMollie as unknown as MollieMock, 'tr_first');

    expect(result).toBe('subscription_created');
    expect(createSub).toHaveBeenCalledOnce();
    expect(lastUpdate).toMatchObject({
      plan: 'paid',
      mollieSubscriptionId: 'sub_abc',
      subscriptionStatus: 'active',
    });
    expect(lastUpdate?.planExpiresAt).toBeInstanceOf(Date);
  });

  it('no-ops a first payment that is not paid', async () => {
    const createSub = vi.fn();
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({
          status: PaymentStatus.failed,
          customerId: 'cst_abc',
          sequenceType: 'first',
        }),
      },
      customerSubscriptions: { create: createSub },
    };
    const { processPaymentWebhook } = await import('./billing.js');
    const result = await processPaymentWebhook(mockMollie as unknown as MollieMock, 'tr_failed');
    expect(result).toBe('ignored_status_failed');
    expect(createSub).not.toHaveBeenCalled();
    expect(lastUpdate).toBeNull();
  });
});

describe('processPaymentWebhook - recurring renewal', () => {
  beforeEach(() => {
    lastUpdate = null;
  });

  it('extends access on a paid recurring payment', async () => {
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({
          status: PaymentStatus.paid,
          customerId: 'cst_abc',
          sequenceType: 'recurring',
          subscriptionId: 'sub_abc',
        }),
      },
      customerSubscriptions: {
        get: vi.fn().mockResolvedValue({ interval: '1 month' }),
      },
    };
    const { processPaymentWebhook } = await import('./billing.js');
    const result = await processPaymentWebhook(mockMollie as unknown as MollieMock, 'tr_recurring');
    expect(result).toBe('renewed');
    expect(lastUpdate).toMatchObject({ plan: 'paid', subscriptionStatus: 'active' });
    expect(lastUpdate?.planExpiresAt).toBeInstanceOf(Date);
  });
});

describe('processPaymentWebhook - edge cases', () => {
  beforeEach(() => {
    lastUpdate = null;
  });

  it('returns no_customer when payment has no customerId', async () => {
    const mockMollie = {
      payments: {
        get: vi.fn().mockResolvedValue({ status: PaymentStatus.paid, customerId: null }),
      },
    };
    const { processPaymentWebhook } = await import('./billing.js');
    const result = await processPaymentWebhook(mockMollie as unknown as MollieMock, 'tr_nocust');
    expect(result).toBe('no_customer');
    expect(lastUpdate).toBeNull();
  });
});

describe('applyPlanFromSubscriptionCancel', () => {
  beforeEach(() => {
    lastUpdate = null;
  });

  it('sets plan=free + clears subscription for the customer', async () => {
    const { applyPlanFromSubscriptionCancel } = await import('./billing.js');
    await applyPlanFromSubscriptionCancel('cst_cancel');
    expect(lastUpdate).toMatchObject({
      plan: 'free',
      subscriptionStatus: 'expired',
      mollieSubscriptionId: null,
      planExpiresAt: null,
    });
  });
});
