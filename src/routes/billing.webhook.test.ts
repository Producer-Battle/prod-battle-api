// Route-level test for the Mollie webhook BODY PARSING - the gap that let the
// "json-only webhook" bug ship to prod (Mollie always sends form-encoded, so
// every real delivery 400'd). We run the real Hono route via app.request with
// MOLLIE_API_KEY unset, so the handler parses the id and then short-circuits
// at the billing_not_configured check - which lets us assert purely on whether
// the id was extracted from the body:
//   id present  -> note 'billing_not_configured'  (id parsed, mollie off)
//   id missing  -> note 'no_id'                   (parse produced nothing)

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: () => ({}) }));
vi.mock('../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema.js')>();
  return { ...actual };
});
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), sql: vi.fn() }));
// MOLLIE_API_KEY unset => getMollieClient() returns null.
vi.mock('../env.js', () => ({ env: { MOLLIE_API_KEY: undefined } }));
vi.mock('../discord/role-sync.js', () => ({ syncSupporterRole: vi.fn(() => Promise.resolve()) }));
// Stub the auth middleware so importing billing.js doesn't boot better-auth
// (which would crash on the minimal env mock). The webhook route is unauthed
// anyway; this only affects /checkout, /cancel, /status which we don't call.
vi.mock('../middleware/session.js', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

async function post(body: string, contentType: string) {
  const { billingRoutes } = await import('./billing.js');
  return billingRoutes.request('/billing/webhook', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('POST /billing/webhook body parsing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('parses the id from a Mollie form-encoded body', async () => {
    const res = await post('id=tr_form123', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { note?: string };
    // billing_not_configured (not no_id) proves the id WAS extracted.
    expect(json.note).toBe('billing_not_configured');
  });

  it('parses the id from a JSON body too', async () => {
    const res = await post(JSON.stringify({ id: 'tr_json123' }), 'application/json');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { note?: string };
    expect(json.note).toBe('billing_not_configured');
  });

  it('returns no_id (200) when the body has no id', async () => {
    const res = await post('foo=bar', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { note?: string };
    expect(json.note).toBe('no_id');
  });
});
