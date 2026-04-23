// Middleware: anonymous identity cookie.
//
// Reads the `pb_anon` cookie. If absent, generates a UUID v4 and sets it as a
// persistent HttpOnly cookie. The id is attached to `c.var.anonId` so
// downstream middleware (e.g. rate-limit.ts) can key per-visitor state
// without relying on auth.
//
// The cookie is Secure in production and plain HTTP in development so local
// testing doesn't require HTTPS.

import { randomUUID } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { env } from '../env.js';

// One year in seconds.
const MAX_AGE = 31_536_000;

// Extend Hono's variable map so TypeScript knows about `c.var.anonId`.
// Other middleware (auth, etc.) may add `user` separately — we only declare
// what this file owns.
declare module 'hono' {
  interface ContextVariableMap {
    anonId: string;
  }
}

export function anonId() {
  return createMiddleware(async (c, next) => {
    let id = getCookie(c, 'pb_anon');

    if (!id) {
      id = randomUUID();
      setCookie(c, 'pb_anon', id, {
        httpOnly: true,
        path: '/',
        maxAge: MAX_AGE,
        sameSite: 'Lax',
        secure: env.NODE_ENV === 'production',
      });
    }

    c.set('anonId', id);
    await next();
  });
}
