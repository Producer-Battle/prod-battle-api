// E2E: chromaprint fingerprint anti-resubmit and cross-user collision detection.
//
// Skipped entirely when fpcalc is not on PATH (CI without chromaprint-tools).
// When fpcalc is available:
//   - Same audio submitted twice by same user -> second rejected as self_resubmit.
//   - Similar audio from two users -> both accepted, report row inserted.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runFingerprintCheck } from '../../audio/fp-check.js';
import { db } from '../../db/client.js';
import { buildTestApp, createMatch, joinRoom, uniqueHandle } from '../harness.js';
import { resetMatchState, seedTestFixtures } from '../seed.js';

const fpcalcAvailable = (() => {
  try {
    execSync('which fpcalc', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = join(tmpdir(), 'pb-fp-e2e');
const sineWavPath = join(dir, 'sine440.wav');
const altSinePath = join(dir, 'sine880.wav');

describe.skipIf(!fpcalcAvailable)('fingerprint e2e', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    execSync(
      `ffmpeg -y -f lavfi -i "sine=frequency=440:duration=5" -ac 1 -ar 22050 "${sineWavPath}"`,
      { stdio: 'ignore' },
    );
    execSync(
      `ffmpeg -y -f lavfi -i "sine=frequency=880:duration=5" -ac 1 -ar 22050 "${altSinePath}"`,
      { stdio: 'ignore' },
    );
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  afterAll(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('second submission of identical audio by same user is rejected', async () => {
    // Insert a submission row manually then call runFingerprintCheck directly,
    // bypassing the NODE_ENV=test gate in the route.
    const d = db();

    // Seed a genre + match so we have valid foreign keys.
    const { genreId } = await seedTestFixtures();
    const matchHandle = uniqueHandle('fp-self');
    const match = await createMatch(app, { mode: 'quickplay' });
    const userId = await joinRoom(app, match.roomCode, matchHandle);

    // Insert a fake prior submission for the same user with a real fingerprint.
    const { fingerprintFile } = await import('../../audio/fingerprint.js');
    const { fingerprint, duration } = await fingerprintFile(sineWavPath);

    // Store it as the prior.
    await d.execute(
      sql`INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, fingerprint, fingerprint_duration_sec, created_at)
          VALUES (gen_random_uuid(), ${match.id}, ${userId}, ${genreId},
                  'https://example.com/prior.wav',
                  ${sql.raw(`ARRAY[${fingerprint.join(',')}]::integer[]`)},
                  ${duration},
                  now() - interval '1 day')`,
    );

    // Insert the "new" submission row.
    const [newSub] = await d.execute<{ id: string }>(
      sql`INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, created_at)
          VALUES (gen_random_uuid(), ${match.id}, ${userId}, ${genreId},
                  'https://example.com/new.wav', now())
          RETURNING id`,
    );
    const newSubId = (newSub as { id: string }).id;

    // Run the fingerprint check against the same fixture (identical audio).
    const result = await runFingerprintCheck(newSubId, userId, sineWavPath);
    expect(result).toBe('self_resubmit');

    // The submission row should now have dq_reason set.
    const [row] = await d.execute<{ dq_reason: string | null }>(
      sql`SELECT dq_reason FROM submissions WHERE id = ${newSubId}`,
    );
    expect((row as { dq_reason: string | null }).dq_reason).toBe('self_resubmit');
  });

  it('cross-user similar audio triggers a report row', async () => {
    const d = db();
    const { genreId } = await seedTestFixtures();
    const match = await createMatch(app, { mode: 'quickplay' });
    const userAHandle = uniqueHandle('fp-cross-a');
    const userBHandle = uniqueHandle('fp-cross-b');
    const userAId = await joinRoom(app, match.roomCode, userAHandle);
    const userBId = await joinRoom(app, match.roomCode, userBHandle);

    const { fingerprintFile } = await import('../../audio/fingerprint.js');
    const { fingerprint: fpA, duration } = await fingerprintFile(sineWavPath);

    // Store user A's submission with fingerprint already set (simulating prior).
    const [subA] = await d.execute<{ id: string }>(
      sql`INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, fingerprint, fingerprint_duration_sec, created_at)
          VALUES (gen_random_uuid(), ${match.id}, ${userAId}, ${genreId},
                  'https://example.com/a.wav',
                  ${sql.raw(`ARRAY[${fpA.join(',')}]::integer[]`)},
                  ${duration},
                  now() - interval '2 hours')
          RETURNING id`,
    );
    const subAId = (subA as { id: string }).id;

    // Insert user B's submission row.
    const [subB] = await d.execute<{ id: string }>(
      sql`INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, created_at)
          VALUES (gen_random_uuid(), ${match.id}, ${userBId}, ${genreId},
                  'https://example.com/b.wav', now())
          RETURNING id`,
    );
    const subBId = (subB as { id: string }).id;

    // Run fingerprint check for user B using the same audio fixture.
    // Self-resubmit check will pass (different user_id), but cross-user will flag.
    const result = await runFingerprintCheck(subBId, userBId, sineWavPath);
    expect(result).toBeNull(); // not rejected, just flagged

    // Give the async cross-user scan a moment to complete.
    await new Promise((r) => setTimeout(r, 200));

    const reportRows = await d.execute<{ id: string; reason: string; notes: string }>(
      sql`SELECT id, reason, notes FROM reports WHERE subject_id = ${subBId} LIMIT 1`,
    );
    const arr = reportRows as Array<{ id: string; reason: string; notes: string }>;
    expect(arr.length).toBe(1);
    expect(arr[0]?.reason).toBe('beat_trade_suspect');
    const notes = JSON.parse(arr[0]?.notes ?? '{}') as {
      submissionId: string;
      otherSubmissionId: string;
      similarity: number;
    };
    expect(notes.otherSubmissionId).toBe(subAId);
    expect(notes.similarity).toBeGreaterThan(0.95);

    void subAId; // suppress unused warning
  });
});
