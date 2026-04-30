// Post-submission fingerprint pipeline:
//   1. Download audio to a temp file.
//   2. Run fpcalc to get a Chromaprint fingerprint.
//   3. Persist the fingerprint on the submission row.
//   4. Compare against the submitter's recent submissions (30 days).
//      - Similarity > 0.85 with any of their own -> mark dq_reason='self_resubmit'.
//   5. Fire-and-forget cross-user scan; similarity > 0.95 -> insert a report.
//
// Returns 'self_resubmit' when the submission must be rejected, null otherwise.
// Never throws - fingerprint failures are non-fatal (fpcalc may be absent in dev).

import { randomUUID } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, submissions } from '../db/schema.js';
import { fingerprintFile } from './fingerprint.js';
import { similarity } from './similarity.js';

const SELF_RESUBMIT_THRESHOLD = 0.85;
const CROSS_USER_THRESHOLD = 0.95;
const WINDOW_DAYS = 30;

async function downloadToTemp(url: string): Promise<string> {
  const dest = join(tmpdir(), `pb-fp-${randomUUID()}.wav`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`fetch ${url} -> ${res.status}`);
  const ws = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, ws);
  return dest;
}

type PriorRow = {
  id: string;
  fingerprint: number[];
};

async function loadRecentFingerprints(
  userId: string,
  excludeId: string,
  crossUser: boolean,
): Promise<PriorRow[]> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400 * 1000).toISOString();
  const d = db();

  if (crossUser) {
    const rows = await d.execute<{ id: string; fingerprint: number[] }>(
      sql`SELECT id, fingerprint
            FROM submissions
           WHERE user_id != ${userId}
             AND fingerprint IS NOT NULL
             AND created_at >= ${cutoff}
           LIMIT 200`,
    );
    return rows as PriorRow[];
  }

  const rows = await d.execute<{ id: string; fingerprint: number[] }>(
    sql`SELECT id, fingerprint
          FROM submissions
         WHERE user_id = ${userId}
           AND id != ${excludeId}
           AND fingerprint IS NOT NULL
           AND created_at >= ${cutoff}`,
  );
  return rows as PriorRow[];
}

async function persistFingerprint(
  submissionId: string,
  fingerprint: number[],
  durationSec: number,
  dqReason: string | null,
): Promise<void> {
  const d = db();
  await d.execute(
    sql`UPDATE submissions
           SET fingerprint = ${sql.raw(`ARRAY[${fingerprint.join(',')}]::integer[]`)},
               fingerprint_duration_sec = ${durationSec},
               dq_reason = ${dqReason}
         WHERE id = ${submissionId}`,
  );
}

async function insertCrossUserReport(
  submissionId: string,
  otherSubmissionId: string,
  sim: number,
): Promise<void> {
  const d = db();
  await d.insert(reports).values({
    subjectType: 'submission',
    subjectId: submissionId,
    reporterId: null,
    reason: 'beat_trade_suspect',
    notes: JSON.stringify({ submissionId, otherSubmissionId, similarity: sim }),
  });
}

// Runs cross-user fingerprint scan as a fire-and-forget. Errors are swallowed.
function fireCrossUserScan(submissionId: string, userId: string, fingerprint: number[]): void {
  loadRecentFingerprints(userId, submissionId, true)
    .then((priors) => {
      let maxSim = 0;
      let maxOtherId = '';
      for (const prior of priors) {
        const s = similarity(fingerprint, prior.fingerprint);
        if (s > maxSim) {
          maxSim = s;
          maxOtherId = prior.id;
        }
      }
      if (maxSim > CROSS_USER_THRESHOLD && maxOtherId) {
        return insertCrossUserReport(submissionId, maxOtherId, maxSim);
      }
    })
    .catch(() => {
      // Non-blocking; logged nowhere intentionally (keep submission path clean).
    });
}

// audioSource: an HTTP/HTTPS URL (production) or an absolute file path (tests/direct).
export async function runFingerprintCheck(
  submissionId: string,
  userId: string,
  audioSource: string,
): Promise<'self_resubmit' | null> {
  let tmpPath: string | null = null;
  try {
    let localPath: string;
    if (audioSource.startsWith('http://') || audioSource.startsWith('https://')) {
      tmpPath = await downloadToTemp(audioSource);
      localPath = tmpPath;
    } else {
      localPath = audioSource;
    }
    const { duration, fingerprint } = await fingerprintFile(localPath);

    // Check own recent submissions first.
    const priors = await loadRecentFingerprints(userId, submissionId, false);
    let selfResubmit = false;
    for (const prior of priors) {
      if (similarity(fingerprint, prior.fingerprint) > SELF_RESUBMIT_THRESHOLD) {
        selfResubmit = true;
        break;
      }
    }

    const dqReason = selfResubmit ? 'self_resubmit' : null;
    await persistFingerprint(submissionId, fingerprint, duration, dqReason);

    if (!selfResubmit) {
      fireCrossUserScan(submissionId, userId, fingerprint);
    }

    return selfResubmit ? 'self_resubmit' : null;
  } catch {
    // fpcalc absent or download failed - non-fatal, submission proceeds.
    return null;
  } finally {
    if (tmpPath) {
      try {
        rmSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}
