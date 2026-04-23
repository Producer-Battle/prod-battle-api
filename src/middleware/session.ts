// Session middleware: turns better-auth's session cookie into `c.var.user`
// + `c.var.session` so downstream handlers can authorize without knowing
// about better-auth directly.
//
// - `attachSession()` is safe to run globally: it reads the session if
//   there is one and sets `c.var.user` / `c.var.session`, otherwise no-op.
//   Never blocks an anonymous request.
// - `requireAuth()` returns 401 when `c.var.user` is absent — use on routes
//   that need a logged-in user.
// - `requireRole(...roles)` returns 403 when the user's role isn't in the
//   allowed set — layered on top of requireAuth.

import { createMiddleware } from 'hono/factory';
import { auth } from '../auth/config.js';

// Shape exposed to handlers. Kept minimal on purpose; if a handler needs a
// field we haven't surfaced here, add it explicitly.
export type AuthUser = {
  id: string;
  email: string;
  handle: string | null;
  role: 'producer' | 'ar' | 'admin';
};

export type AuthSession = {
  id: string;
  expiresAt: Date;
};

declare module 'hono' {
  interface ContextVariableMap {
    user?: AuthUser;
    session?: AuthSession;
  }
}

/**
 * Populate `c.var.user` + `c.var.session` if a valid session cookie exists.
 * Always calls `next()` — never blocks.
 */
export function attachSession() {
  return createMiddleware(async (c, next) => {
    try {
      const result = await auth.api.getSession({ headers: c.req.raw.headers });
      if (result?.user && result?.session) {
        const u = result.user as {
          id: string;
          email: string;
          handle?: string | null;
          name?: string | null;
          role?: string;
        };
        c.set('user', {
          id: u.id,
          email: u.email,
          handle: u.handle ?? u.name ?? null,
          role: (u.role as AuthUser['role']) ?? 'producer',
        });
        c.set('session', {
          id: result.session.id,
          expiresAt: new Date(result.session.expiresAt),
        });
      }
    } catch (err) {
      // Session lookup errors (e.g. Redis blip if we ever move sessions
      // there) must not take down the request — just proceed anonymous.
      console.warn('[session] attachSession failed:', (err as Error).message);
    }
    await next();
  });
}

/** 401 when no authenticated user. */
export function requireAuth() {
  return createMiddleware(async (c, next) => {
    if (!c.var.user) {
      return c.json({ error: 'unauthenticated', message: 'Sign in to continue.' }, 401);
    }
    await next();
  });
}

/**
 * 403 when the authenticated user's role isn't in the allowed set.
 * Combine with requireAuth() — this middleware assumes c.var.user is set.
 */
export function requireRole(...roles: AuthUser['role'][]) {
  return createMiddleware(async (c, next) => {
    const user = c.var.user;
    if (!user) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    if (!roles.includes(user.role)) {
      return c.json({ error: 'forbidden', message: `Requires one of: ${roles.join(', ')}` }, 403);
    }
    await next();
  });
}
