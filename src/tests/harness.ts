// Test harness. Builds a production-shaped Hono app in-process so tests
// hit real handlers via app.request() without opening a port, without
// mounting better-auth, and without starting the tick loop.
//
// The middleware chain mirrors server.ts minus:
//   - CORS           (unused for in-process requests)
//   - /auth/* mount  (keeps better-auth out of the test import graph)
//   - attachSession  (skipped -> every request is anonymous, which is
//                     the flow we want for the mode-per-file e2e tests)
//
// Flow helpers wrap the REST sequence each mode runs:
//   createMatch -> join -> start -> submit -> vote -> results

import { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { anonId } from '../middleware/anon-id.js';
import type { AuthUser } from '../middleware/session.js';
import { registerRoutes } from '../routes/index.js';

export type BuildTestAppOptions = {
  /**
   * When set, installs a middleware that stubs c.var.user with these exact
   * values. Omit (or leave undefined) to keep every request anonymous,
   * which is the default behaviour used by all existing e2e test files.
   */
  asUser?: {
    id: string;
    handle: string;
    email: string;
    role: AuthUser['role'];
    plan: AuthUser['plan'];
    status?: AuthUser['status'];
  };
};

export function buildTestApp(opts: BuildTestAppOptions = {}): OpenAPIHono {
  const app = new OpenAPIHono();
  app.use('*', anonId());
  if (opts.asUser) {
    // Default to 'active' so callers can keep using the pre-status shape.
    const stubUser: AuthUser = { status: 'active', ...opts.asUser };
    app.use(
      '*',
      createMiddleware(async (c, next) => {
        c.set('user', stubUser);
        await next();
      }),
    );
  }
  registerRoutes(app);
  return app;
}

type JsonBody = Record<string, unknown> | unknown[];

export async function postJson<T = unknown>(
  app: OpenAPIHono,
  path: string,
  body?: JsonBody,
): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

export async function getJson<T = unknown>(
  app: OpenAPIHono,
  path: string,
): Promise<{ status: number; json: T }> {
  const res = await app.request(path);
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

export async function patchJson<T = unknown>(
  app: OpenAPIHono,
  path: string,
  body?: JsonBody,
): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

// ─── High-level flow helpers ──────────────────────────────────────────────

export type CreatedMatch = {
  id: string;
  mode: string;
  roomCode: string;
  teamSize: number;
  teamCount: number;
  submitSeconds: number;
  genre: { slug: string; name: string };
  status: string;
  samplePack: { id: string } | null;
  flipSource: { id: string; label: string; url: string } | null;
};

export async function createMatch(
  app: OpenAPIHono,
  body: Record<string, unknown>,
): Promise<CreatedMatch> {
  const { status, json } = await postJson<CreatedMatch>(app, '/matches', body);
  if (status !== 201) {
    throw new Error(`createMatch failed: ${status} ${JSON.stringify(json)}`);
  }
  return json;
}

export async function joinRoom(app: OpenAPIHono, code: string, handle: string): Promise<string> {
  const { status, json } = await postJson<{ userId: string }>(app, `/rooms/${code}/join`, {
    user: handle,
  });
  if (status !== 200) {
    throw new Error(`join(${handle}) failed: ${status} ${JSON.stringify(json)}`);
  }
  return json.userId;
}

export async function startRoom(app: OpenAPIHono, code: string, handle: string): Promise<void> {
  const { status, json } = await postJson(app, `/rooms/${code}/start`, { user: handle });
  if (status !== 200) {
    throw new Error(`start failed: ${status} ${JSON.stringify(json)}`);
  }
}

export async function submitTrack(
  app: OpenAPIHono,
  code: string,
  handle: string,
  opts: { durationSec?: number; title?: string } = {},
): Promise<string> {
  // Step 1: request a signed upload URL (mocked, returns a key).
  const urlRes = await postJson<{ key: string }>(app, `/rooms/${code}/upload-url`, {
    user: handle,
    contentType: 'audio/mpeg',
  });
  if (urlRes.status !== 200) {
    throw new Error(`upload-url failed: ${urlRes.status} ${JSON.stringify(urlRes.json)}`);
  }
  // Step 2: the browser would PUT to S3 here. Skipped in tests.
  // Step 3: finalize the submission.
  const subRes = await postJson<{ id: string }>(app, `/rooms/${code}/submission`, {
    user: handle,
    key: urlRes.json.key,
    title: opts.title,
    durationSec: opts.durationSec ?? 30,
  });
  if (subRes.status !== 200) {
    throw new Error(`submission failed: ${subRes.status} ${JSON.stringify(subRes.json)}`);
  }
  return subRes.json.id;
}

export type RevealItem = { submissionId: string; label: string };

export async function getReveal(app: OpenAPIHono, code: string): Promise<RevealItem[]> {
  const { status, json } = await getJson<{ items: RevealItem[] }>(app, `/matches/${code}/reveal`);
  if (status !== 200) {
    throw new Error(`reveal failed: ${status} ${JSON.stringify(json)}`);
  }
  return json.items;
}

/**
 * Cast votes from `handle` for every submission that isn't theirs.
 * Expects the caller to already be in (or created by) a prior step; the
 * vote endpoint auto-creates users by handle for audience voters.
 */
export async function voteForAll(
  app: OpenAPIHono,
  code: string,
  handle: string,
  ownSubmissionId: string | null,
  items: RevealItem[],
  score = 5,
): Promise<void> {
  const targets = items
    .filter((i) => i.submissionId !== ownSubmissionId)
    .map((i) => ({ submissionId: i.submissionId, score }));
  if (targets.length === 0) return;
  const { status, json } = await postJson(app, `/rooms/${code}/vote`, {
    user: handle,
    votes: targets,
  });
  if (status !== 200) {
    throw new Error(`vote(${handle}) failed: ${status} ${JSON.stringify(json)}`);
  }
}

export type ResultsItem = {
  rank: number;
  submissionId: string;
  handle: string;
  title: string | null;
  audioUrl: string;
  score: number;
};

export async function getResults(app: OpenAPIHono, code: string): Promise<ResultsItem[]> {
  const { status, json } = await getJson<{ items: ResultsItem[] }>(app, `/matches/${code}/results`);
  if (status !== 200) {
    throw new Error(`results failed: ${status} ${JSON.stringify(json)}`);
  }
  return json.items;
}

export type FetchedMatch = CreatedMatch & {
  currentPhase: string | null;
  voteOutcome: 'complete' | 'incomplete' | null;
  voteStats: { seated: number; voted: number; fullVoted: number };
};

export async function getMatch(app: OpenAPIHono, code: string): Promise<FetchedMatch> {
  const { status, json } = await getJson<FetchedMatch>(app, `/matches/${code}`);
  if (status !== 200) {
    throw new Error(`get match failed: ${status} ${JSON.stringify(json)}`);
  }
  return json;
}

// Produces a short, unique handle per call. Prefix isolates test files from
// each other and from any residual data that slipped past truncation.
let counter = 0;
export function uniqueHandle(prefix: string): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
