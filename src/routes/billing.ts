// Recurring Supporter subscriptions via Mollie.
//
// Endpoints:
//   POST /billing/checkout - start a subscription. Creates a "first" payment
//                            that, once paid, establishes a mandate. Returns a
//                            hosted checkout URL.
//   POST /billing/webhook  - Mollie calls this for every payment. We branch on
//                            sequenceType:
//                              first     -> mandate now exists; create the
//                                           recurring subscription, set
//                                           plan=paid + planExpiresAt.
//                              recurring -> renewal; extend planExpiresAt.
//   POST /billing/cancel   - cancel the Mollie subscription. Plan stays 'paid'
//                            until planExpiresAt; the expiration cron then
//                            demotes to 'free'.
//   GET  /billing/status   - current plan + subscription state for the UI.
//
// Mollie (EU) instead of Stripe because the operator is EU-based. MOLLIE_API_KEY
// is optional; when unset, /checkout returns 503 and /webhook no-ops with 200.
//
// Security note: Mollie webhooks deliberately carry only a resource id. We
// re-fetch the payment from Mollie's API and only act on real, paid payments
// that belong to a customer we have on file - a forged id resolves to a 404 or
// to a customer we don't know, so it can't grant a plan.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { PaymentStatus, SequenceType, createMollieClient } from '@mollie/api-client';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { syncSupporterRole } from '../discord/role-sync.js';
import { env } from '../env.js';
import { requireAuth } from '../middleware/session.js';

export const billingRoutes = new OpenAPIHono();

type MollieClient = ReturnType<typeof createMollieClient>;

function getMollieClient(): MollieClient | null {
  if (!env.MOLLIE_API_KEY) return null;
  return createMollieClient({ apiKey: env.MOLLIE_API_KEY });
}

const checkoutBody = z.object({
  interval: z.enum(['monthly', 'yearly']),
});
type Interval = z.infer<typeof checkoutBody>['interval'];

// Prices per interval, formatted as Mollie amount strings.
// Yearly is monthly x 12 with 20% off (€2.95 x 12 x 0.80 = €28.32).
const PRICES: Record<Interval, { amount: string; label: string }> = {
  monthly: { amount: '2.95', label: 'Prod Battle Supporter - monthly' },
  yearly: { amount: '28.32', label: 'Prod Battle Supporter - yearly (save 20%)' },
};

// Mollie interval strings + how many days of access each grants (with a 2-day
// grace so a slightly-late renewal charge doesn't briefly demote the user).
const MOLLIE_INTERVAL: Record<Interval, string> = {
  monthly: '1 month',
  yearly: '12 months',
};
function accessUntil(interval: Interval, from = new Date()): Date {
  const d = new Date(from);
  if (interval === 'yearly') d.setUTCDate(d.getUTCDate() + 365 + 2);
  else d.setUTCDate(d.getUTCDate() + 30 + 2);
  return d;
}

const apiBase = () => env.AUTH_BASE_URL ?? 'https://api.prodbattle.com';
const webBase = () => env.WEB_ORIGIN?.split(',')[0] ?? 'https://prodbattle.com';
const webhookUrl = () => `${apiBase()}/billing/webhook`;

// ─── POST /billing/checkout ───────────────────────────────────────────────────

const checkoutRoute = createRoute({
  method: 'post',
  path: '/billing/checkout',
  tags: ['billing'],
  summary: 'Start a recurring Supporter subscription',
  request: { body: { content: { 'application/json': { schema: checkoutBody } } } },
  responses: {
    200: {
      description: 'Checkout URL',
      content: { 'application/json': { schema: z.object({ checkoutUrl: z.string().url() }) } },
    },
    401: { description: 'Unauthenticated' },
    409: { description: 'Already subscribed' },
    503: { description: 'Billing not configured' },
  },
});

billingRoutes.use('/billing/checkout', requireAuth());
billingRoutes.use('/billing/cancel', requireAuth());
billingRoutes.use('/billing/status', requireAuth());

billingRoutes.openapi(checkoutRoute, async (c) => {
  const mollie = getMollieClient();
  if (!mollie) {
    return c.json({ error: 'billing_not_configured', message: 'Billing is not enabled yet.' }, 503);
  }

  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const { interval } = c.req.valid('json');
  const d = db();

  const [row] = await d
    .select({
      mollieCustomerId: users.mollieCustomerId,
      plan: users.plan,
      subscriptionStatus: users.subscriptionStatus,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (row?.plan === 'paid' && row?.subscriptionStatus === 'active') {
    return c.json(
      { error: 'already_subscribed', message: 'You already have an active subscription.' },
      409,
    );
  }

  // Resolve or create the Mollie customer so payments + mandates + the
  // subscription all attach to one identity.
  const freshCustomer = async (): Promise<string> => {
    const customer = await mollie.customers.create({
      name: user.handle ?? undefined,
      email: user.email,
      metadata: { userId: user.id },
    });
    await d
      .update(users)
      .set({ mollieCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return customer.id;
  };

  let mollieCustomerId = row?.mollieCustomerId ?? (await freshCustomer());

  const { amount, label } = PRICES[interval];

  // A "first" sequence payment establishes a reusable mandate when it's paid.
  // We create the recurring subscription in the webhook once the mandate
  // exists. metadata.interval is read back there to size the subscription.
  const makePayment = (customerId: string) =>
    mollie.payments.create({
      amount: { currency: 'EUR', value: amount },
      customerId,
      sequenceType: SequenceType.first,
      description: label,
      redirectUrl: `${webBase()}/settings?billing=success`,
      webhookUrl: webhookUrl(),
      metadata: { userId: user.id, interval },
    });

  let payment: Awaited<ReturnType<typeof makePayment>>;
  try {
    payment = await makePayment(mollieCustomerId);
  } catch (err) {
    // A stored customer created in a different API mode (the classic
    // test->live switch) makes Mollie reject it: "Customer ... exists, but
    // the wrong mode is used" / 404. Mint a fresh customer in the current
    // mode and retry once.
    const msg = (err as Error).message?.toLowerCase() ?? '';
    if (msg.includes('wrong mode') || msg.includes('not found') || msg.includes('customer')) {
      console.warn('[billing] stale Mollie customer, recreating:', (err as Error).message);
      mollieCustomerId = await freshCustomer();
      payment = await makePayment(mollieCustomerId);
    } else {
      throw err;
    }
  }

  // Prefer the typed accessor; fall back to the HAL link if the SDK's
  // overloaded return type hides it from TS.
  const checkoutUrl =
    (payment as { _links?: { checkout?: { href?: string } } })._links?.checkout?.href ?? '';
  if (!checkoutUrl) {
    console.error('[billing] Mollie first payment missing checkout URL');
    return c.json({ error: 'checkout_failed', message: 'Could not create checkout URL.' }, 500);
  }

  return c.json({ checkoutUrl }, 200);
});

// ─── POST /billing/webhook ────────────────────────────────────────────────────
//
// Plain Hono route, NOT an OpenAPI/zod-json route. Mollie ALWAYS delivers
// webhooks as application/x-www-form-urlencoded with a single `id=tr_xxx`
// field - it never sends JSON. A json-only route silently parsed id as
// undefined and 400'd every real delivery, so the plan-flip never ran. We
// read the id from form or json so both Mollie and manual/test callers work.

billingRoutes.post('/billing/webhook', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let id: string | undefined;
  if (contentType.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
    if (typeof body.id === 'string') id = body.id;
  } else {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    if (typeof form.id === 'string') id = form.id;
  }

  if (!id) {
    console.warn('[billing] webhook missing id');
    return c.json({ ok: true, note: 'no_id' }, 200);
  }
  console.info('[billing] webhook received:', id);

  const mollie = getMollieClient();
  if (!mollie) return c.json({ ok: true, note: 'billing_not_configured' }, 200);

  try {
    const result = await processPaymentWebhook(mollie, id);
    return c.json({ ok: true, note: result }, 200);
  } catch (err) {
    // 400 => Mollie retries. Use only for genuinely transient failures.
    console.error('[billing] webhook error:', (err as Error).message);
    return c.json({ error: 'webhook_error', message: (err as Error).message }, 400);
  }
});

// ─── POST /billing/cancel ─────────────────────────────────────────────────────

const cancelRoute = createRoute({
  method: 'post',
  path: '/billing/cancel',
  tags: ['billing'],
  summary: 'Cancel the active subscription (access continues until period end)',
  responses: {
    200: {
      description: 'Cancelled',
      content: {
        'application/json': {
          schema: z.object({
            cancelled: z.boolean(),
            accessUntil: z.string().nullable(),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated' },
    404: { description: 'No active subscription' },
    503: { description: 'Billing not configured' },
  },
});

billingRoutes.openapi(cancelRoute, async (c) => {
  const mollie = getMollieClient();
  if (!mollie) return c.json({ error: 'billing_not_configured', message: 'Billing is off.' }, 503);

  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const d = db();

  const [row] = await d
    .select({
      mollieCustomerId: users.mollieCustomerId,
      mollieSubscriptionId: users.mollieSubscriptionId,
      planExpiresAt: users.planExpiresAt,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!row?.mollieCustomerId || !row?.mollieSubscriptionId) {
    return c.json({ error: 'no_subscription', message: 'No active subscription to cancel.' }, 404);
  }

  // Cancel at Mollie - stops future charges. Mollie keeps the mandate so the
  // user can resubscribe later without re-entering card details.
  await mollie.customerSubscriptions.cancel(row.mollieSubscriptionId, {
    customerId: row.mollieCustomerId,
  });

  // Keep plan='paid' until the period they already paid for ends; the cron
  // demotes them after planExpiresAt.
  await d
    .update(users)
    .set({ subscriptionStatus: 'canceled', updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return c.json(
    { cancelled: true, accessUntil: row.planExpiresAt ? row.planExpiresAt.toISOString() : null },
    200,
  );
});

// ─── GET /billing/status ──────────────────────────────────────────────────────

const statusRoute = createRoute({
  method: 'get',
  path: '/billing/status',
  tags: ['billing'],
  summary: 'Current plan + subscription state',
  responses: {
    200: {
      description: 'Status',
      content: {
        'application/json': {
          schema: z.object({
            plan: z.enum(['free', 'paid']),
            subscriptionStatus: z.string().nullable(),
            planExpiresAt: z.string().nullable(),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated' },
  },
});

billingRoutes.openapi(statusRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const d = db();
  const [row] = await d
    .select({
      plan: users.plan,
      subscriptionStatus: users.subscriptionStatus,
      planExpiresAt: users.planExpiresAt,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return c.json(
    {
      plan: row?.plan ?? 'free',
      subscriptionStatus: row?.subscriptionStatus ?? null,
      planExpiresAt: row?.planExpiresAt ? row.planExpiresAt.toISOString() : null,
    },
    200,
  );
});

// ─── Core webhook processing (exported for tests) ─────────────────────────────

type PaymentLike = {
  status: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  sequenceType?: string | null;
  metadata?: { interval?: Interval } | null;
};

/**
 * Process a Mollie payment webhook by id. Branches on sequenceType:
 *   first     paid -> create the recurring subscription, set plan=paid +
 *                     planExpiresAt + subscriptionStatus=active.
 *   recurring paid -> renewal; extend planExpiresAt.
 *   anything else / not paid -> no-op (Mollie handles dunning + retries).
 *
 * Returns a short status string for logging/tests.
 */
export async function processPaymentWebhook(
  mollie: MollieClient,
  paymentId: string,
): Promise<string> {
  const d = db();
  const payment = (await mollie.payments.get(paymentId)) as unknown as PaymentLike;
  const customerId = payment.customerId ?? null;
  if (!customerId) return 'no_customer';

  if (payment.status !== PaymentStatus.paid) {
    return `ignored_status_${payment.status}`;
  }

  const seq = payment.sequenceType ?? 'oneoff';

  if (seq === 'first') {
    // Idempotency: Mollie retries any non-200 webhook and can deliver the
    // same first-payment event more than once. Without this guard the second
    // delivery tries to create a duplicate subscription, Mollie returns
    // "a subscription with the same description already exists", we 400, and
    // Mollie retries forever.
    //
    // We only short-circuit when the existing subscription is ACTIVE - a
    // cancelled-but-not-yet-expired user (subscriptionStatus='canceled',
    // subId still set until the expiry cron clears it) must be able to
    // resubscribe, so we let them fall through to create a fresh one.
    const [existing] = await d
      .select({ subId: users.mollieSubscriptionId, subStatus: users.subscriptionStatus })
      .from(users)
      .where(eq(users.mollieCustomerId, customerId))
      .limit(1);
    if (existing?.subId && existing.subStatus === 'active') {
      console.info(`[billing] first payment for ${customerId} already active, skipping`);
      return 'already_subscribed';
    }

    const interval: Interval = payment.metadata?.interval ?? 'monthly';
    const { amount, label } = PRICES[interval];

    // Create the recurring subscription. startDate is the next interval so the
    // already-charged first payment counts as period 1 (no double charge).
    const start = new Date();
    if (interval === 'yearly') start.setUTCFullYear(start.getUTCFullYear() + 1);
    else start.setUTCMonth(start.getUTCMonth() + 1);

    let sub: { id: string };
    try {
      sub = await mollie.customerSubscriptions.create({
        customerId,
        amount: { currency: 'EUR', value: amount },
        interval: MOLLIE_INTERVAL[interval],
        description: label,
        webhookUrl: webhookUrl(),
        startDate: start.toISOString().slice(0, 10),
      });
    } catch (err) {
      // Belt-and-suspenders for the case the DB guard above can't catch (e.g.
      // a prior create succeeded at Mollie but our DB write failed, or a
      // customer with no user row): Mollie rejects the duplicate with "a
      // subscription with the same description already exists". Treat that as
      // already-done and return 200 so Mollie stops retrying.
      if ((err as Error).message?.toLowerCase().includes('already exists')) {
        console.info(`[billing] subscription already exists for ${customerId}, treating as done`);
        return 'already_subscribed';
      }
      throw err;
    }

    const updated = await d
      .update(users)
      .set({
        plan: 'paid',
        mollieSubscriptionId: sub.id,
        subscriptionStatus: 'active',
        planExpiresAt: accessUntil(interval),
        updatedAt: new Date(),
      })
      .where(eq(users.mollieCustomerId, customerId))
      .returning({ id: users.id });
    for (const u of updated) syncSupporterRole(u.id, true).catch(() => undefined);
    console.info(`[billing] subscription ${sub.id} active for customer ${customerId}`);
    return 'subscription_created';
  }

  if (seq === 'recurring') {
    // Renewal charge succeeded - extend access. Interval is inferred from the
    // subscription tied to the payment; default monthly if unavailable.
    let interval: Interval = 'monthly';
    try {
      if (payment.subscriptionId) {
        const sub = (await mollie.customerSubscriptions.get(payment.subscriptionId, {
          customerId,
        })) as unknown as { interval?: string };
        if (sub.interval?.includes('12')) interval = 'yearly';
      }
    } catch {
      // fall back to monthly
    }
    await d
      .update(users)
      .set({
        plan: 'paid',
        subscriptionStatus: 'active',
        planExpiresAt: accessUntil(interval),
        updatedAt: new Date(),
      })
      .where(eq(users.mollieCustomerId, customerId));
    console.info(`[billing] renewal for customer ${customerId}, extended access`);
    return 'renewed';
  }

  return `ignored_sequence_${seq}`;
}

// Legacy helper kept for the existing test surface. Delegates to the new path.
export async function applyPlanFromPayment(
  mollieClient: MollieClient,
  paymentId: string,
): Promise<'paid' | 'no_change' | 'not_found'> {
  const result = await processPaymentWebhook(mollieClient, paymentId);
  if (result === 'no_customer') return 'not_found';
  if (result === 'subscription_created' || result === 'renewed') return 'paid';
  return 'no_change';
}

export async function applyPlanFromSubscriptionCancel(mollieCustomerId: string): Promise<void> {
  const d = db();
  const updated = await d
    .update(users)
    .set({
      plan: 'free',
      subscriptionStatus: 'expired',
      mollieSubscriptionId: null,
      planExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.mollieCustomerId, mollieCustomerId))
    .returning({ id: users.id });
  console.info(`[billing] plan set to free for Mollie customer ${mollieCustomerId}`);
  for (const u of updated) syncSupporterRole(u.id, false).catch(() => undefined);
}
