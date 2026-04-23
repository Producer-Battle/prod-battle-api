// better-auth instance for the prod-battle API.
//
// Providers:
//   - email + password (no verification gate - user.emailVerified defaults to
//     true so sign-up lands the user straight into a session)
//   - Google OAuth (conditionally enabled - only if both env vars are set)
//
// Drizzle adapter backs all persistence (users, accounts, sessions,
// verifications) against the same Postgres we already use. The `users`
// table is shared with the rest of the app - better-auth writes email /
// emailVerified / handle (as `name`) / avatarUrl (as `image`) via the
// field mapping below.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
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
    // No verification friction - sign-up returns a live session immediately.
    requireEmailVerification: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
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
