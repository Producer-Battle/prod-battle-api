// Structured logger - one place to swap console.log for proper sinks.
//
// Today: emits a single JSON line per call to stdout/stderr. Cloudflare's
// log explorer (and most aggregators) parses JSON natively, so we get
// queryable fields without picking a logging library yet.
//
// Tomorrow: when @sentry/node is wired (env.SENTRY_DSN), error and warn
// calls also send to Sentry via the bridge in ./sentry.ts. Today the
// bridge is a no-op so Sentry is opt-in and zero-cost when unconfigured.
//
// Usage:
//   import { logger } from '../observability/logger.js';
//   logger.info('match.created', { matchId, mode });
//   logger.warn('cluster.collision', { matchId, userId });
//   logger.error('outcome.failed', { matchId }, err);
//
// Avoid console.log in new code. Migrate hot paths first; the codebase
// has ~80 console.log calls today, can be backfilled gradually.

import { env } from '../env.js';
import { captureException, captureMessage } from './sentry.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, unknown>;

function emit(level: Level, event: string, fields: Fields | undefined, error: unknown): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    env: env.NODE_ENV,
    ...(fields ?? {}),
  };
  if (error instanceof Error) {
    entry.error = { name: error.name, message: error.message, stack: error.stack };
  } else if (error !== undefined) {
    entry.error = String(error);
  }
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else if (level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);

  if (level === 'error') captureException(error, { event, ...(fields ?? {}) });
  else if (level === 'warn') captureMessage(event, 'warning', fields);
}

export const logger = {
  debug(event: string, fields?: Fields): void {
    if (env.NODE_ENV === 'production') return;
    emit('debug', event, fields, undefined);
  },
  info(event: string, fields?: Fields): void {
    emit('info', event, fields, undefined);
  },
  warn(event: string, fields?: Fields): void {
    emit('warn', event, fields, undefined);
  },
  error(event: string, fields?: Fields, error?: unknown): void {
    emit('error', event, fields, error);
  },
};
