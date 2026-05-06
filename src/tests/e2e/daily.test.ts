import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  getJson,
  getResults,
  getReveal,
  joinRoom,
  postJson,
  submitTrack,
  uniqueHandle,
} from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

type DailyChallenge = {
  date: string;
  genre: { slug: string; name: string };
  samplePack: { id: string } | null;
  roomCode: string;
  submissionCount: number;
  cap: number;
};

describe('mode: daily (Daily Challenge)', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('lazily creates today shared match, accepts submissions + votes, exposes results', async () => {
    const paidUser = await seedTestUser(uniqueHandle('dl-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: paidUser });

    const first = await getJson<DailyChallenge>(app, '/daily-challenge');
    expect(first.status).toBe(200);
    expect(first.json.cap).toBe(20);
    expect(first.json.submissionCount).toBe(0);
    expect(first.json.roomCode).toMatch(/^[A-Z0-9]{6}$/);

    // A second call must hit the same match (partial unique index on daily_date).
    const second = await getJson<DailyChallenge>(app, '/daily-challenge');
    expect(second.json.roomCode).toBe(first.json.roomCode);

    const code = first.json.roomCode;

    // Two distinct paid producers drop submissions. Daily matches don't have a
    // lobby, but we still call join() once per producer as a cheap way to
    // create the user row the submission endpoint looks up by handle.
    const aUser = await seedTestUser(uniqueHandle('dl-a'), { plan: 'paid', role: 'producer' });
    const bUser = await seedTestUser(uniqueHandle('dl-b'), { plan: 'paid', role: 'producer' });
    const appA = buildTestApp({ asUser: aUser });
    const appB = buildTestApp({ asUser: bUser });

    await joinRoom(appA, code, aUser.handle);
    await joinRoom(appB, code, bUser.handle);
    // Daily Challenge enforces a 90s..240s submission length. The default
    // submitTrack helper sends 30s which would be rejected with 'too_short'.
    const subA = await submitTrack(appA, code, aUser.handle, { durationSec: 120 });
    const subB = await submitTrack(appB, code, bUser.handle, { durationSec: 150 });
    expect(subA).not.toBe(subB);

    // Daily matches stay in 'submit' status during the submission window.
    // Votes are NOT accepted until the match flips to 'vote' (day N+1).
    const reveal = await getReveal(app, code);
    expect(reveal).toHaveLength(2);

    // Voting during 'submit' phase must be rejected.
    const voteWhileSubmit = await postJson(appB, `/rooms/${code}/vote`, {
      user: bUser.handle,
      votes: [{ submissionId: subA, score: 5 }],
    });
    expect(voteWhileSubmit.status).toBe(400);

    // The results endpoint still returns the submissions (rank=0 until rollover).
    const results = await getResults(app, code);
    expect(results.map((r) => r.submissionId).sort()).toEqual([subA, subB].sort());

    // submissionCount on /daily-challenge reflects the 2 new entries.
    const third = await getJson<DailyChallenge>(app, '/daily-challenge');
    expect(third.json.submissionCount).toBe(2);
  });

  it('blocks a second submission from the same handle with 409', async () => {
    const paidUser = await seedTestUser(uniqueHandle('dl-dup-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: paidUser });

    const dc = await getJson<DailyChallenge>(app, '/daily-challenge');
    const code = dc.json.roomCode;
    const h = paidUser.handle;
    await joinRoom(app, code, h);
    await submitTrack(app, code, h, { durationSec: 120 });

    // Second submit from the same handle must hit the unique-per-match guard.
    const urlRes = await postJson<{ key: string }>(app, `/rooms/${code}/upload-url`, {
      user: h,
      contentType: 'audio/mpeg',
    });
    const finalize = await postJson(app, `/rooms/${code}/submission`, {
      user: h,
      key: urlRes.json.key,
      title: 'second try',
      durationSec: 30,
    });
    expect(finalize.status).toBe(409);
  });

  it('returns 402 for anonymous visitors', async () => {
    // No asUser - every request is anonymous.
    const app = buildTestApp();
    const res = await getJson<{ error: string }>(app, '/daily-challenge');
    expect(res.status).toBe(402);
    expect(res.json.error).toBe('payment_required');
  });

  it('returns 402 for free-tier users', async () => {
    const freeUser = await seedTestUser(uniqueHandle('dl-free'), {
      plan: 'free',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: freeUser });
    const res = await getJson<{ error: string }>(app, '/daily-challenge');
    expect(res.status).toBe(402);
    expect(res.json.error).toBe('payment_required');
  });

  it('admins bypass the paid gate', async () => {
    // Admin with plan='free' - plan doesn't matter; role='admin' passes the gate.
    const adminUser = await seedTestUser(uniqueHandle('dl-admin'), { plan: 'free', role: 'admin' });
    const app = buildTestApp({ asUser: adminUser });
    const res = await getJson<DailyChallenge>(app, '/daily-challenge');
    expect(res.status).toBe(200);
    expect(res.json.roomCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('submitting to a daily match as a free user returns 402', async () => {
    // Paid user fetches the room code (passes the GET gate).
    const paidUser = await seedTestUser(uniqueHandle('dl-get-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const paidApp = buildTestApp({ asUser: paidUser });
    const dc = await getJson<DailyChallenge>(paidApp, '/daily-challenge');
    expect(dc.status).toBe(200);
    const code = dc.json.roomCode;

    // Free user tries to submit - POST /rooms/:code/submission must 402.
    const freeUser = await seedTestUser(uniqueHandle('dl-sub-free'), {
      plan: 'free',
      role: 'producer',
    });
    const freeApp = buildTestApp({ asUser: freeUser });

    // join() creates the user row; daily mode doesn't require a seated player.
    await joinRoom(freeApp, code, freeUser.handle);

    // Skip upload-url (S3 presigner is mocked but bucket() throws before it).
    // The paid-tier gate fires before any S3 access so a fake key is fine here.
    const finalize = await postJson<{ error: string }>(freeApp, `/rooms/${code}/submission`, {
      user: freeUser.handle,
      key: `matches/fake-match-id/${freeUser.id}.mp3`,
      durationSec: 30,
    });
    expect(finalize.status).toBe(402);
    expect(finalize.json.error).toBe('payment_required');
  });

  it("hides the daily sample pack until the caller enters today's challenge", async () => {
    const paidUser = await seedTestUser(uniqueHandle('dl-peek'), {
      plan: 'paid',
      role: 'producer',
    });
    const paidApp = buildTestApp({ asUser: paidUser });
    const dc = await getJson<DailyChallenge>(paidApp, '/daily-challenge');
    const code = dc.json.roomCode;

    // Anonymous caller (no session, no ?user) must see no signed pack URLs.
    // The metadata is fine to leak - genre, code, count - but signed audio
    // URLs would let them grab the kit and walk without commitment.
    const anonApp = buildTestApp();
    const anonView = await getJson<{
      samplePack: { samples: Array<{ url: string }> } | null;
    }>(anonApp, `/matches/${code}`);
    expect(anonView.json.samplePack).toBeNull();

    // Authenticated caller who hasn't entered yet also sees no pack.
    const beforeEnter = await getJson<{
      samplePack: { samples: unknown[] } | null;
    }>(paidApp, `/matches/${code}`);
    expect(beforeEnter.json.samplePack).toBeNull();

    // Enter the daily challenge - this seats the user in match_players.
    const enter = await postJson<{ ok: true; alreadyEntered: boolean }>(
      paidApp,
      '/daily-challenge/enter',
    );
    expect(enter.status).toBe(200);
    expect(enter.json.alreadyEntered).toBe(false);

    // After entry the pack is revealed with signed URLs.
    const afterEnter = await getJson<{
      samplePack: { samples: Array<{ url: string }> } | null;
    }>(paidApp, `/matches/${code}`);
    expect(afterEnter.json.samplePack).not.toBeNull();
    expect(afterEnter.json.samplePack?.samples.length ?? 0).toBeGreaterThan(0);

    // Idempotent: re-entering returns alreadyEntered=true and does not
    // duplicate the seat.
    const reenter = await postJson<{ ok: true; alreadyEntered: boolean }>(
      paidApp,
      '/daily-challenge/enter',
    );
    expect(reenter.json.alreadyEntered).toBe(true);
  });

  it('rejects /daily-challenge/enter from anonymous callers with 401', async () => {
    const anonApp = buildTestApp();
    const res = await postJson(anonApp, '/daily-challenge/enter');
    expect(res.status).toBe(401);
  });
});
