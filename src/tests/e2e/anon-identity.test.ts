// E2E tests for the pb_anon guest-identity binding.
//
// A guest's identity credential is the server-issued HttpOnly pb_anon
// cookie, not their public handle. Each buildTestApp() instance carries its
// own cookie jar, so two apps behave like two different browsers.
//
// Covered here:
//   - joining binds the handle to the caller's cookie
//   - a different "browser" cannot join, ready, or vote as that handle
//   - legacy guest stubs (anon_id NULL) are claimed on first touch
//   - registered accounts are never resolvable by bare handle
//   - one browser may operate several handles (shared-computer flow)
//   - /me/claim-guest-handle refuses guests bound to another browser

import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import {
  buildTestApp,
  createMatch,
  joinRoom,
  postJson,
  startRoom,
  submitTrack,
  uniqueHandle,
} from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

async function anonIdOf(handle: string): Promise<string | null> {
  const d = db();
  const [row] = await d
    .select({ anonId: users.anonId })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  return row?.anonId ?? null;
}

describe('anon identity binding', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('join binds the handle to the caller cookie; another browser is locked out', async () => {
    const browserA = buildTestApp();
    const browserB = buildTestApp();

    const match = await createMatch(browserA, { mode: 'quickplay' });
    const handle = uniqueHandle('anon-bind');

    await joinRoom(browserA, match.roomCode, handle);
    expect(await anonIdOf(handle)).not.toBeNull();

    // Browser B tries to join the same room under A's handle.
    const joinAsA = await postJson(browserB, `/rooms/${match.roomCode}/join`, { user: handle });
    expect(joinAsA.status).toBe(409);

    // Browser B tries to flip A's ready state.
    const readyAsA = await postJson(browserB, `/rooms/${match.roomCode}/ready`, { user: handle });
    expect(readyAsA.status).toBe(403);

    // Browser A itself can still do both.
    const readyAsSelf = await postJson(browserA, `/rooms/${match.roomCode}/ready`, {
      user: handle,
    });
    expect(readyAsSelf.status).toBe(200);
  });

  it('one browser can operate multiple guest handles (shared computer)', async () => {
    const app = buildTestApp();
    const match = await createMatch(app, { mode: 'quickplay' });

    const h1 = uniqueHandle('anon-multi-1');
    const h2 = uniqueHandle('anon-multi-2');
    await joinRoom(app, match.roomCode, h1);
    await joinRoom(app, match.roomCode, h2);

    // Both rows exist, bound to the same cookie.
    const [a1, a2] = [await anonIdOf(h1), await anonIdOf(h2)];
    expect(a1).not.toBeNull();
    expect(a1).toEqual(a2);
  });

  it('legacy guest stubs (anon_id NULL) are claimed on first touch', async () => {
    const d = db();
    const handle = uniqueHandle('anon-legacy');
    await d.execute(
      sql`INSERT INTO users (id, email, handle, role)
          VALUES (gen_random_uuid(), ${handle} || '@guest.local', ${handle}, 'producer')`,
    );
    expect(await anonIdOf(handle)).toBeNull();

    const browserA = buildTestApp();
    const match = await createMatch(browserA, { mode: 'quickplay' });
    await joinRoom(browserA, match.roomCode, handle);

    const claimed = await anonIdOf(handle);
    expect(claimed).not.toBeNull();

    // And from then on a second browser is locked out.
    const browserB = buildTestApp();
    const joinAsA = await postJson(browserB, `/rooms/${match.roomCode}/join`, { user: handle });
    expect(joinAsA.status).toBe(409);
  });

  it('registered accounts are never resolvable by bare handle', async () => {
    const real = await seedTestUser(uniqueHandle('anon-real'), {
      plan: 'free',
      role: 'producer',
    });

    const guestBrowser = buildTestApp();
    const match = await createMatch(guestBrowser, { mode: 'quickplay' });

    // join as the registered user's handle -> rejected, and the real
    // account's row must NOT get bound to the guest's cookie.
    const join = await postJson(guestBrowser, `/rooms/${match.roomCode}/join`, {
      user: real.handle,
    });
    expect(join.status).toBe(409);
    expect(await anonIdOf(real.handle)).toBeNull();

    // ready/leave as the registered handle -> 403.
    const ready = await postJson(guestBrowser, `/rooms/${match.roomCode}/ready`, {
      user: real.handle,
    });
    expect(ready.status).toBe(403);
  });

  it('audience vote cannot impersonate a handle bound to another browser', async () => {
    const browserA = buildTestApp();
    const browserB = buildTestApp();

    // A 2-player match driven entirely from browser A (two handles, same
    // cookie - allowed), advanced into the vote phase.
    const match = await createMatch(browserA, { mode: 'quickplay' });
    const p1 = uniqueHandle('anon-vote-1');
    const p2 = uniqueHandle('anon-vote-2');
    await joinRoom(browserA, match.roomCode, p1);
    await joinRoom(browserA, match.roomCode, p2);
    await startRoom(browserA, match.roomCode, p1);
    await submitTrack(browserA, match.roomCode, p1);
    const p2SubId = await submitTrack(browserA, match.roomCode, p2);

    // Browser B votes under p1's handle -> forbidden.
    const forged = await postJson(browserB, `/rooms/${match.roomCode}/vote`, {
      user: p1,
      votes: [{ submissionId: p2SubId, score: 5 }],
    });
    expect(forged.status).toBe(403);

    // Browser B can still vote as a fresh audience handle of its own.
    const own = await postJson(browserB, `/rooms/${match.roomCode}/vote`, {
      user: uniqueHandle('anon-audience'),
      votes: [{ submissionId: p2SubId, score: 4 }],
    });
    expect(own.status).toBe(200);
  });

  it('claim-guest-handle refuses guests bound to a different browser', async () => {
    // Guest plays from browser A.
    const browserA = buildTestApp();
    const match = await createMatch(browserA, { mode: 'quickplay' });
    const guestHandle = uniqueHandle('anon-claim');
    await joinRoom(browserA, match.roomCode, guestHandle);
    const boundTo = await anonIdOf(guestHandle);
    expect(boundTo).not.toBeNull();

    // A registered user on browser B (fresh jar = different pb_anon)
    // tries to absorb that guest's history by handle.
    const caller = await seedTestUser(uniqueHandle('anon-claimer'), {
      plan: 'free',
      role: 'producer',
    });
    const browserB = buildTestApp({ asUser: caller });
    const { status, json } = await postJson<{ error: string }>(browserB, '/me/claim-guest-handle', {
      guestHandle,
    });
    expect(status).toBe(403);
    expect(json.error).toBe('guest_not_yours');

    // The binding is untouched.
    expect(await anonIdOf(guestHandle)).toEqual(boundTo);
  });
});
