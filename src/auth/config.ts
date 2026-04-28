// better-auth instance for the prod-battle API.
//
// Providers:
//   - email + password (verification required - new sign-ups are held at
//     emailVerified=false until the user clicks the link we send via SMTP)
//   - Google OAuth (conditionally enabled - only if both env vars are set)
//
// Drizzle adapter backs all persistence (users, accounts, sessions,
// verifications) against the same Postgres we already use. The `users`
// table is shared with the rest of the app - better-auth writes email /
// emailVerified / handle (as `name`) / avatarUrl (as `image`) via the
// field mapping below.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import * as schema from '../db/schema.js';
import { env } from '../env.js';

const googleConfigured = Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);

// Dev fallback so `pnpm dev` without a .env still boots. In prod the
// AUTH_SECRET env var MUST be set to a ≥32-char random string.
const authSecret =
  env.AUTH_SECRET ??
  (env.NODE_ENV === 'production' ? '' : 'dev-only-insecure-secret-0123456789abcdef');

const baseUrl = env.AUTH_BASE_URL ?? `http://localhost:${env.PORT}`;

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: 'pg',
    // Keys must match what better-auth's internal router asks for. With
    // usePlural=true it looks up "users" / "accounts" / etc.
    schema: {
      users: schema.users,
      accounts: schema.accounts,
      sessions: schema.sessions,
      verifications: schema.verifications,
    },
    usePlural: true,
  }),

  secret: authSecret,
  baseURL: baseUrl,
  // Without this, better-auth defaults to `/api/auth/*` - but we mount at
  // `/auth/*` in server.ts (and the web client hits `/auth/*` directly).
  // Align them so /auth/sign-up/email, /auth/get-session, etc. resolve.
  basePath: '/auth',
  trustedOrigins: (env.AUTH_TRUSTED_ORIGINS ?? env.WEB_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Anti-enumeration: with requireEmailVerification=true better-auth
    // returns a fake "synthetic user" instead of an error when an email
    // is already registered (so attackers can't probe whether an email
    // exists). The honest user is left staring at a "check your email"
    // screen with no email coming. This hook lets us send THAT user a
    // real "you already have an account" email so their inbox gets
    // something actionable, without leaking which emails exist.
    sendResetPassword: async ({ user, url }) => {
      // better-auth has already baked the callbackURL into `url` from the
      // client's `redirectTo` (see /auth/request-password-reset). When the
      // user clicks, the API validates the token and 302s to that callback
      // (our /auth/reset-password page) with the token still attached.
      const finalUrl = url;

      const nodemailer = await import('nodemailer');
      const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: smtpPort === 465,
        logger: process.env.SMTP_DEBUG === '1',
        debug: process.env.SMTP_DEBUG === '1',
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 30000,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
      void transport
        .sendMail({
          from: process.env.SMTP_FROM ?? 'noreply@prodbattle.com',
          to: user.email,
          subject: 'Reset your Producer Battle password',
          text: `Someone (probably you) asked to reset your Producer Battle password. Open this link within an hour to choose a new one: ${finalUrl}\n\nIf you didn't request this, you can ignore this email.`,
          html: `<p>Someone (probably you) asked to reset your Producer Battle password.</p><p><a href="${finalUrl}">Choose a new password</a> (link expires in 1 hour).</p><p>If you didn't request this, you can ignore this email.</p>`,
        })
        .catch((err: Error) => {
          console.warn('[auth] sendResetPassword mail failed:', err.message);
        });
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1h reset window
    // Clicking a reset link sent to the registered email is proof of email
    // ownership, same as clicking the original verification link. Without
    // this, users who never confirmed (e.g. delivery failed) would reset
    // their password and then still hit 403 on sign-in due to
    // requireEmailVerification=true. Flip the flag so the reset itself
    // unblocks them. better-auth doesn't do this on its own.
    onPasswordReset: async ({ user }) => {
      try {
        await getDb()
          .update(schema.users)
          .set({ emailVerified: true, updatedAt: new Date() })
          .where(eq(schema.users.id, user.id));
      } catch (err) {
        console.warn('[auth] onPasswordReset verify-flip failed:', (err as Error).message);
      }
    },
    onExistingUserSignUp: async ({ user }) => {
      try {
        const candidates = (env.WEB_ORIGIN ?? 'http://localhost:5173')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const webOrigin =
          candidates.find((c) => c.startsWith('https://') && !c.includes('*')) ??
          candidates[0] ??
          'http://localhost:5173';
        const signInUrl = `${webOrigin}/auth/sign-in`;
        const nodemailer = await import('nodemailer');
        const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: smtpPort,
          // Port 465 = SMTPS (TLS-on-connect). Anything else uses plain
          // STARTTLS (587) or unencrypted (1025 dev mailpit).
          secure: smtpPort === 465,
          logger: process.env.SMTP_DEBUG === '1',
          debug: process.env.SMTP_DEBUG === '1',
          connectionTimeout: 30000,
          greetingTimeout: 30000,
          socketTimeout: 30000,
          auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
        });
        // Fire-and-forget: signup must not hang on a slow SMTP path.
        void transport
          .sendMail({
            from: process.env.SMTP_FROM ?? 'noreply@prodbattle.com',
            to: user.email,
            subject: 'You already have a Producer Battle account',
            text: `Someone (probably you) tried to sign up with this email. You already have an account - sign in here: ${signInUrl}`,
            html: `<p>Someone (probably you) tried to sign up with this email.</p><p>You already have an account: <a href="${signInUrl}">sign in</a>.</p>`,
          })
          .catch((err: Error) => {
            console.warn('[auth] onExistingUserSignUp mail failed:', err.message);
          });
      } catch (err) {
        console.warn('[auth] onExistingUserSignUp setup failed:', (err as Error).message);
      }
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      // Override better-auth's default callbackURL (which is just '/').
      // The default '/' resolves to the API origin which has no UI -
      // browsers land on a 404 after click. Send users to the web
      // frontend instead. WEB_ORIGIN is a comma-separated list of
      // ALLOWED origins (for CORS); pick the first https entry as the
      // canonical web URL, falling back to the first entry, else dev.
      const candidates = (env.WEB_ORIGIN ?? 'http://localhost:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const webOrigin =
        candidates.find((c) => c.startsWith('https://') && !c.includes('*')) ??
        candidates[0] ??
        'http://localhost:5173';
      const verifyUrl = new URL(url);
      verifyUrl.searchParams.set('callbackURL', `${webOrigin}/auth/sign-in?verified=1`);
      const finalUrl = verifyUrl.toString();

      // Use nodemailer via SMTP. The compose stack runs mailpit on :1025
      // in dev; prod uses Mailu via SMTPS on port 465. Tight connection
      // timeouts so signup never hangs on a slow / blocked SMTP path -
      // we'd rather the user see "check your email" and the mail be
      // late or lost than the request never return.
      const nodemailer = await import('nodemailer');
      const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        // 465 = SMTPS (TLS-on-connect). Other ports use plain or STARTTLS.
        secure: smtpPort === 465,
        logger: process.env.SMTP_DEBUG === '1',
        debug: process.env.SMTP_DEBUG === '1',
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 30000,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
      // Fire-and-forget: better-auth's contract is async but it doesn't
      // care about the result; surface failures as a log instead.
      void transport
        .sendMail({
          from: process.env.SMTP_FROM ?? 'noreply@prodbattle.com',
          to: user.email,
          subject: 'Confirm your Producer Battle account',
          text: `Welcome to Producer Battle. Confirm your email: ${finalUrl}`,
          html: `<p>Welcome to Producer Battle.</p><p><a href="${finalUrl}">Confirm your email</a></p>`,
        })
        .catch((err: Error) => {
          console.warn('[auth] verifyEmail mail failed:', err.message);
        });
    },
    sendOnSignUp: true,
    expiresIn: 60 * 60 * 24, // 24h verification window
  },

  socialProviders: googleConfigured
    ? {
        google: {
          clientId: env.GOOGLE_OAUTH_CLIENT_ID as string,
          clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET as string,
        },
      }
    : {},

  user: {
    // Map better-auth's conceptual fields onto our existing column names.
    // We keep `handle` / `avatarUrl` in the schema because the rest of the
    // app references them; this mapping just tells better-auth to read/write
    // against those columns when it asks for `name` / `image`.
    fields: {
      name: 'handle',
      image: 'avatarUrl',
    },
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'producer',
        input: false, // role can't be self-assigned at sign-up; admins promote
      },
      plan: {
        type: 'string',
        required: false,
        defaultValue: 'free',
        input: false, // plan can't be self-assigned; set via payment webhook
      },
      status: {
        type: 'string',
        required: false,
        defaultValue: 'active',
        input: false, // status is admin-managed; self-deactivate is future work
      },
    },
  },

  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 min in-memory before re-checking DB
    },
    expiresIn: 60 * 60 * 24 * 30, // 30 days
  },

  advanced: {
    cookiePrefix: 'pb_',
    useSecureCookies: env.NODE_ENV === 'production',
    // Our schema uses uuid columns everywhere. better-auth's default id
    // generator returns 15-char nanoids which Postgres rejects with
    // "invalid input syntax for type uuid". The "uuid" preset calls
    // crypto.randomUUID() instead, producing a real v4 UUID.
    database: {
      generateId: 'uuid' as const,
    },
  },
});

export const isGoogleOAuthConfigured = (): boolean => googleConfigured;
