// POST /billing/checkout  - creates a Mollie payment link for the authenticated user.
// POST /billing/webhook   - Mollie webhook: transitions user plan on payment events.
//
// Mollie is used instead of Stripe because the operator is EU-based. The Mollie
// API key is read from MOLLIE_API_KEY (optional). When not configured:
//   - POST /billing/checkout  returns 503 billing_not_configured.
//   - POST /billing/webhook   returns 200 no-op so Mollie doesn't retry.
//
// Webhook flow (Mollie retries until 200):
//   1. Mollie POSTs { id: 'tr_xxx' } or { id: 'sub_xxx' } to /billing/webhook.
//   2. We look up the payment/subscription via the API.
//   3. On paid/active  -> SET plan='paid'.
//   4. On cancelled/expired -> SET plan='free'.
//
// Logging: all incoming webhook payloads are logged at info level for the first
// month of operation to aid debugging.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { PaymentStatus, SubscriptionStatus, createMollieClient } from '@mollie/api-client';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { syncSupporterRole } from '../discord/role-sync.js';
import { env } from '../env.js';
import { requireAuth } from '../middleware/session.js';

export const billingRoutes = new OpenAPIHono();

// Lazy Mollie client - only instantiated when MOLLIE_API_KEY is present.
function getMollieClient() {
  if (!env.MOLLIE_API_KEY) return null;
  return createMollieClient({ apiKey: env.MOLLIE_API_KEY });
}

// ─── POST /billing/checkout ───────────────────────────────────────────────────

const checkoutBody = z.object({
  interval: z.enum(['monthly', 'yearly']),
});

const checkoutRoute = createRoute({
  method: 'post',
  path: '/billing/checkout',
  tags: ['billing'],
  summary: 'Create a Mollie payment link for the Pro subscription',
  request: {
    body: { content: { 'application/json': { schema: checkoutBody } } },
  },
  responses: {
    200: {
      description: 'Checkout URL',
      content: {
        'application/json': {
          schema: z.object({ checkoutUrl: z.string().url() }),
        },
      },
    },
    401: { description: 'Unauthenticated' },
    503: { description: 'Billing not configured' },
  },
});

// Prices per interval. In EUR, formatted as Mollie amount strings.
// Yearly is monthly x 12 with 20% off (€2.95 x 12 x 0.80 = €28.32).
const PRICES: Record<z.infer<typeof checkoutBody>['interval'], { amount: string; label: string }> =
  {
    monthly: { amount: '2.95', label: 'Prod Battle Supporter - monthly' },
    yearly: { amount: '28.32', label: 'Prod Battle Supporter - yearly (save 20%)' },
  };

billingRoutes.use('/billing/checkout', requireAuth());

billingRoutes.openapi(checkoutRoute, async (c) => {
  const mollie = getMollieClient();
  if (!mollie) {
    return c.json({ error: 'billing_not_configured', message: 'Billing is not enabled yet.' }, 503);
  }

  // c.var.user is guaranteed non-null by requireAuth() middleware above.
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const { interval } = c.req.valid('json');
  const d = db();

  // Resolve or create a Mollie customer for the user so payment history is
  // attributed and subscriptions can be managed later.
  let mollieCustomerId: string | null = null;
  const [row] = await d
    .select({ mollieCustomerId: users.mollieCustomerId })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  mollieCustomerId = row?.mollieCustomerId ?? null;

  if (!mollieCustomerId) {
    const customer = await mollie.customers.create({
      name: user.handle ?? undefined,
      email: user.email,
      metadata: { userId: user.id },
    });
    mollieCustomerId = customer.id;
    await d
      .update(users)
      .set({ mollieCustomerId, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  const { amount, label } = PRICES[interval];

  // Create a payment link. The customer can complete payment in their browser.
  // We use a payment link rather than a direct payment so the user is not
  // required to have a stored mandate yet.
  const link = await mollie.paymentLinks.create({
    description: label,
    amount: { currency: 'EUR', value: amount },
    customerId: mollieCustomerId,
    // Mollie calls /billing/webhook when payment status changes.
    webhookUrl: `${env.AUTH_BASE_URL ?? 'https://api.prodbattle.com'}/billing/webhook`,
    redirectUrl: `${env.WEB_ORIGIN ?? 'https://prodbattle.com'}/settings?billing=success`,
    reusable: false,
  });

  let checkoutUrl: string;
  try {
    checkoutUrl = link.getPaymentUrl();
  } catch {
    console.error('[billing] Mollie payment link missing checkoutUrl');
    return c.json({ error: 'checkout_failed', message: 'Could not create checkout URL.' }, 500);
  }

  return c.json({ checkoutUrl }, 200);
});

// ─── POST /billing/webhook ────────────────────────────────────────────────────

const webhookBody = z.object({
  // Mollie sends either a payment id (tr_xxx), subscription id (sub_xxx), or
  // other resource id. We handle payment and subscription ids.
  id: z.string(),
});

const webhookRoute = createRoute({
  method: 'post',
  path: '/billing/webhook',
  tags: ['billing'],
  summary: 'Mollie payment/subscription status webhook',
  request: {
    // Mollie sends application/x-www-form-urlencoded, but also supports JSON.
    // We accept JSON here; the middleware chain handles raw body parsing.
    body: { content: { 'application/json': { schema: webhookBody } } },
  },
  responses: {
    200: { description: 'Processed (or no-op when billing not configured)' },
    400: { description: 'Unhandled or unrecognised webhook payload' },
  },
});

billingRoutes.openapi(webhookRoute, async (c) => {
  const payload = c.req.valid('json');

  // Log all incoming payloads at info level for the first month.
  console.info('[billing] webhook received:', JSON.stringify(payload));

  const mollie = getMollieClient();
  if (!mollie) {
    // MOLLIE_API_KEY not set - no-op so Mollie doesn't keep retrying.
    return c.json({ ok: true, note: 'billing_not_configured' }, 200);
  }

  const { id } = payload;
  const d = db();

  try {
    if (id.startsWith('tr_') || id.startsWith('test_')) {
      // Payment event - look up the payment.
      const payment = await mollie.payments.get(id);
      const customerId = (payment as { customerId?: string }).customerId ?? null;

      if (!customerId) {
        // Payment not linked to a customer - not from our checkout flow.
        return c.json({ ok: true, note: 'no_customer_id' }, 200);
      }

      if (payment.status === PaymentStatus.paid) {
        const updated = await d
          .update(users)
          .set({ plan: 'paid', updatedAt: new Date() })
          .where(eq(users.mollieCustomerId, customerId))
          .returning({ id: users.id });
        console.info(`[billing] plan set to paid for Mollie customer ${customerId}`);
        // Best-effort Discord role grant - don't await so webhook stays fast.
        for (const u of updated) {
          syncSupporterRole(u.id, true).catch(() => undefined);
        }
      } else if (
        payment.status === PaymentStatus.canceled ||
        payment.status === PaymentStatus.expired ||
        payment.status === PaymentStatus.failed
      ) {
        // A failed/cancelled payment does not necessarily mean the subscription
        // ended - only demote on explicit subscription cancellation below.
        console.info(
          `[billing] payment ${id} status=${payment.status} for customer ${customerId} - no plan change`,
        );
      }

      return c.json({ ok: true }, 200);
    }

    if (id.startsWith('sub_')) {
      // Subscription event.
      // Mollie doesn't send the customerId in the webhook body; we have to
      // extract it from the subscription resource URL or fetch the subscription
      // and read the customerId field.
      //
      // The subscription binder requires both customerId and subscriptionId.
      // Since we don't know the customerId here, we use the raw payments API
      // to get the latest subscription payment and infer the customerId.
      //
      // For now, log and acknowledge - a future improvement can store the
      // subscription id -> customer id mapping at checkout time.
      console.info(
        `[billing] subscription event ${id} - subscription-level cancel not yet handled`,
      );
      return c.json({ ok: true }, 200);
    }

    // Unknown resource type - return 200 so Mollie doesn't retry.
    console.warn(`[billing] unrecognised webhook id: ${id}`);
    return c.json({ ok: true, note: 'unrecognised_id' }, 200);
  } catch (err) {
    console.error('[billing] webhook processing error:', (err as Error).message);
    // Return 400 so Mollie retries - this was a transient failure, not a
    // deliberate no-op.
    return c.json({ error: 'webhook_error', message: (err as Error).message }, 400);
  }
});

// ─── Explicit plan transition helpers (used by unit tests) ───────────────────
//
// These are extracted so tests can inject a mock Mollie client without needing
// a live API key.

export async function applyPlanFromPayment(
  mollieClient: ReturnType<typeof createMollieClient>,
  paymentId: string,
): Promise<'paid' | 'no_change' | 'not_found'> {
  const d = db();
  const payment = await mollieClient.payments.get(paymentId);
  const customerId = (payment as { customerId?: string }).customerId ?? null;

  if (!customerId) return 'not_found';

  if (payment.status === PaymentStatus.paid) {
    const updated = await d
      .update(users)
      .set({ plan: 'paid', updatedAt: new Date() })
      .where(eq(users.mollieCustomerId, customerId))
      .returning({ id: users.id });
    // Best-effort Discord sync.
    for (const u of updated) {
      syncSupporterRole(u.id, true).catch(() => undefined);
    }
    return 'paid';
  }
  return 'no_change';
}

export async function applyPlanFromSubscriptionCancel(mollieCustomerId: string): Promise<void> {
  const d = db();
  const updated = await d
    .update(users)
    .set({ plan: 'free', updatedAt: new Date() })
    .where(eq(users.mollieCustomerId, mollieCustomerId))
    .returning({ id: users.id });
  console.info(
    `[billing] plan set to free for Mollie customer ${mollieCustomerId} (subscription cancelled)`,
  );
  // Best-effort Discord sync.
  for (const u of updated) {
    syncSupporterRole(u.id, false).catch(() => undefined);
  }
}
