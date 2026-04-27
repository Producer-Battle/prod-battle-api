// Integration test for the full email-verification signup flow.
//
// Real services: Postgres + mailpit (the compose-stack SMTP sink at
// http://localhost:8025 / smtp://localhost:1025). Real better-auth handler
// mounted on the test app so /auth/sign-up/email, /auth/verify-email, and
// /auth/sign-in/email behave exactly like prod.
//
// Flow:
//   1. POST /auth/sign-up/email   -> better-auth creates user (emailVerified=false),
//                                    nodemailer sends verification email to mailpit.
//   2. Poll mailpit REST API until the verification email shows up.
//   3. Extract the verification URL from the email body and request its path.
//   4. Better-auth flips emailVerified=true.
//   5. POST /auth/sign-in/email   -> success, session cookie issued.
//
// Skipped silently when mailpit isn't reachable, because the integration tier
// is run by vitest.integration.config.ts which expects compose to be up.

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth } from '../../auth/config.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { anonId } from '../../middleware/anon-id.js';
import { attachSession } from '../../middleware/session.js';
import { registerRoutes } from '../../routes/index.js';
import { resetMatchState } from '../seed.js';

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

function buildAuthApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  // Mirror server.ts. Must use app.all for the auth handler - app.on with
  // a method array silently drops GET in Hono 4.12.x, which would cause
  // /auth/verify-email (a GET) to 404 in the live server even when this
  // test passed.
  app.all('/auth/*', (c) => auth.handler(c.req.raw));
  app.use('*', attachSession());
  app.use('*', anonId());
  registerRoutes(app);
  return app;
}

type MailpitMessage = {
  ID: string;
  From: { Address: string; Name: string };
  To: { Address: string; Name: string }[];
  Subject: string;
  Created: string;
  Snippet: string;
};

async function waitForVerificationEmail(
  toEmail: string,
  timeoutMs = 10_000,
): Promise<{ id: string; verifyUrl: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await fetch(
      `${MAILPIT_URL}/api/v1/messages?query=${encodeURIComponent(`to:${toEmail}`)}`,
    );
    if (list.ok) {
      const json = (await list.json()) as { messages: MailpitMessage[] };
      const msg = json.messages.find((m) => m.To.some((t) => t.Address === toEmail));
      if (msg) {
        // Fetch the full message to get the body.
        const full = await fetch(`${MAILPIT_URL}/api/v1/message/${msg.ID}`);
        const fullJson = (await full.json()) as { Text?: string; HTML?: string };
        const body = fullJson.HTML ?? fullJson.Text ?? '';
        const match = body.match(/https?:\/\/[^\s"<>]+\/auth\/verify-email[^\s"<>]+/);
        if (!match) {
          throw new Error(
            `verification email arrived but no /auth/verify-email URL in body: ${body.slice(0, 200)}`,
          );
        }
        return { id: msg.ID, verifyUrl: match[0] };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for verification email to ${toEmail}`);
}

async function deleteMailpitMessage(id: string): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: [id] }),
  }).catch(() => {});
}

describe('auth flow (integration)', () => {
  let mailpitOk = false;
  let app: OpenAPIHono;

  beforeAll(async () => {
    try {
      const r = await fetch(`${MAILPIT_URL}/api/v1/messages`);
      mailpitOk = r.ok;
    } catch {
      mailpitOk = false;
    }
    app = buildAuthApp();
  });

  beforeEach(async () => {
    await resetMatchState();
  });

  afterAll(async () => {
    // Best-effort cleanup of any messages we left behind.
    await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' }).catch(() => {});
  });

  it('GET /auth/get-session is routed (not 404)', async () => {
    // Regression guard: a previous server.ts used app.on(['GET','POST'], ...)
    // which silently dropped GET registrations on Hono 4.12.x, so every
    // /auth/* GET (including the verify-email link emailed to new sign-ups)
    // 404'd in the live server. Hitting any GET auth endpoint and asserting
    // it doesn't 404 is enough to catch that regression.
    const res = await app.request('/auth/get-session', { method: 'GET' });
    expect(res.status).not.toBe(404);
  });

  it('signup -> verify via emailed link -> signin succeeds', async () => {
    if (!mailpitOk) {
      console.warn('mailpit not reachable at', MAILPIT_URL, '- skipping');
      return;
    }

    const email = `auth-flow-${Date.now()}@test.local`;
    const password = 'integrationtest12345';
    const name = `auth-flow-${Date.now()}`;

    // 1. Sign up.
    const signupRes = await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    expect(signupRes.status).toBeGreaterThanOrEqual(200);
    expect(signupRes.status).toBeLessThan(300);

    // emailVerified should still be false at this point.
    const [beforeVerify] = await db()
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    expect(beforeVerify?.emailVerified).toBe(false);

    // 2. Wait for the verification email and extract the link.
    const { id: msgId, verifyUrl } = await waitForVerificationEmail(email);
    const verifyPath = new URL(verifyUrl).pathname + new URL(verifyUrl).search;

    // 3. Hit the verification URL.
    const verifyRes = await app.request(verifyPath, { method: 'GET', redirect: 'manual' });
    // Better-auth responds with a 302 to callbackURL on success.
    expect(verifyRes.status).toBe(302);
    // Regression guard: callbackURL MUST point at the web frontend, not
    // the API origin. Earlier the email leaked the default '/' which
    // landed users on the API root (404 in the browser) after click.
    const location = verifyRes.headers.get('location') ?? '';
    // Mirror the picker in src/auth/config.ts: prefer first https entry,
    // else first entry, else localhost dev fallback.
    const candidates = (process.env.WEB_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const expectedOrigin =
      candidates.find((c) => c.startsWith('https://') && !c.includes('*')) ??
      candidates[0] ??
      'http://localhost:5173';
    expect(location.startsWith(expectedOrigin)).toBe(true);

    // 4. emailVerified should now be true.
    const [afterVerify] = await db()
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    expect(afterVerify?.emailVerified).toBe(true);

    // 5. Sign in - should succeed and return a session cookie.
    const signinRes = await app.request('/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(signinRes.status).toBeGreaterThanOrEqual(200);
    expect(signinRes.status).toBeLessThan(300);
    // Better-auth's cookiePrefix='pb_' produces names like
    // 'pb_.session_token' and 'pb_.session_data'.
    const setCookie = signinRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/pb_\.session_token=/i);

    await deleteMailpitMessage(msgId);
  });

  it('signin before verification fails', async () => {
    if (!mailpitOk) return;

    const email = `auth-flow-unverified-${Date.now()}@test.local`;
    const password = 'integrationtest12345';
    const name = `auth-unverified-${Date.now()}`;

    await app.request('/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });

    // Drain the verification email so we don't pollute the inbox.
    const { id } = await waitForVerificationEmail(email).catch(() => ({ id: '' }));
    if (id) await deleteMailpitMessage(id);

    const signinRes = await app.request('/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    // Better-auth returns 401 / 403 when emailVerified=false and
    // requireEmailVerification is on. Either is acceptable.
    expect(signinRes.status).toBeGreaterThanOrEqual(400);
    expect(signinRes.status).toBeLessThan(500);
  });
});
