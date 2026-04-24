import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetMatchState, seedTestFixtures } from '../seed.js';
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

type DailyChallenge = {
  date: string;
  genre: { slug: string; name: string };
  samplePack: { id: string } | null;
  roomCode: string;
  submissionCount: number;
  cap: number;
};

describe('mode: daily (Daily Challenge)', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('lazily creates today shared match, accepts submissions + votes, exposes results', async () => {
    const first = await getJson<DailyChallenge>(app, '/daily-challenge');
    expect(first.status).toBe(200);
    expect(first.json.cap).toBe(20);
    expect(first.json.submissionCount).toBe(0);
    expect(first.json.roomCode).toMatch(/^[A-Z0-9]{6}$/);

    // A second call must hit the same match (partial unique index on daily_date).
    const second = await getJson<DailyChallenge>(app, '/daily-challenge');
    expect(second.json.roomCode).toBe(first.json.roomCode);

    const code = first.json.roomCode;

    // Two distinct producers drop submissions. Daily matches don't have a
    // lobby, but we still call join() once per producer as a cheap way to
    // create the user row the submission endpoint looks up by handle.
    const a = uniqueHandle('dl-a');
    const b = uniqueHandle('dl-b');
    await joinRoom(app, code, a);
    await joinRoom(app, code, b);
    const subA = await submitTrack(app, code, a);
    const subB = await submitTrack(app, code, b);
    expect(subA).not.toBe(subB);

    // Daily matches stay in 'submit' status - votes are accepted anyway.
    const reveal = await getReveal(app, code);
    expect(reveal).toHaveLength(2);

    const voteRes = await postJson(app, `/rooms/${code}/vote`, {
      user: b,
      votes: [{ submissionId: subA, score: 5 }],
    });
    expect(voteRes.status).toBe(200);

    // Daily matches don't run tally/rank until the UTC rollover. The
    // results endpoint still returns the submissions (rank=0 until then).
    const results = await getResults(app, code);
    expect(results.map((r) => r.submissionId).sort()).toEqual([subA, subB].sort());

    // submissionCount on /daily-challenge reflects the 2 new entries.
    const third = await getJson<DailyChallenge>(app, '/daily-challenge');
    expect(third.json.submissionCount).toBe(2);
  });

  it('blocks a second submission from the same handle with 409', async () => {
    const dc = await getJson<DailyChallenge>(app, '/daily-challenge');
    const code = dc.json.roomCode;
    const h = uniqueHandle('dl-dup');
    await joinRoom(app, code, h);
    await submitTrack(app, code, h);

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
});
