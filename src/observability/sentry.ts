// Sentry bridge. Today: a no-op shim - SENTRY_DSN is read from env but
// nothing is actually sent because @sentry/node isn't installed yet.
// Tomorrow: install @sentry/node, swap these stubs for real init + capture
// calls. The logger.ts API (info/warn/error) stays the same either way.
//
// Two-step rollout reasoning:
//   1. Land the abstraction so all error logging goes through one place.
//   2. Wire the SDK once a DSN exists. No code outside this file changes.

import { env } from '../env.js';

let initialised = false;

export function initSentry(): void {
  if (initialised) return;
  initialised = true;
  if (!env.SENTRY_DSN) {
    return; // intentional no-op when DSN is missing
  }
  // TODO: when @sentry/node is added:
  //   const Sentry = await import('@sentry/node');
  //   Sentry.init({
  //     dsn: env.SENTRY_DSN,
  //     environment: env.NODE_ENV,
  //     tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ?? (env.NODE_ENV === 'production' ? 0.1 : 1),
  //   });
  // For now we just record that it was called so logger.warn/error
  // know the bridge is "armed".
}

export function captureException(_err: unknown, _context?: Record<string, unknown>): void {
  if (!env.SENTRY_DSN) return;
  // TODO: Sentry.captureException(err, { extra: context });
}

export function captureMessage(
  _message: string,
  _level: 'info' | 'warning' | 'error',
  _context?: Record<string, unknown>,
): void {
  if (!env.SENTRY_DSN) return;
  // TODO: Sentry.captureMessage(message, { level, extra: context });
}
