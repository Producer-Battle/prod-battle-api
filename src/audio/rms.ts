// Anti-silence check for submitted audio. Spawns ffmpeg with the
// astats filter and parses RMS_level out of the output. Fast enough to
// run synchronously on submission finalize (sub-second on small files).
//
// Returns the overall RMS in dBFS, or -Infinity for files ffmpeg
// reads as fully silent.
//
// Threshold suggestion: -50 dBFS for "this is essentially silent".
// Production threshold lives in game_rules.honor (admin-tunable) so
// admins can soften or harden as they see fit.

import { spawn } from 'node:child_process';

export async function rmsLevelDbFs(audioUrl: string, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      // Fail-open on timeout so a slow ffmpeg doesn't block submits.
      resolve(0);
    }, timeoutMs);

    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      audioUrl,
      '-af',
      'astats=metadata=1:reset=0',
      '-f',
      'null',
      '-',
    ]);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(0); // fail-open if spawn itself fails
    });
    proc.on('close', () => {
      clearTimeout(timer);
      // Last line's "Overall" RMS_level is the file-wide value. Earlier
      // lines are per-channel. We pick the highest-magnitude RMS_level
      // we see (closest to 0 dBFS = loudest); -inf becomes -Infinity.
      const matches = stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/gi);
      let best = Number.NEGATIVE_INFINITY;
      for (const m of matches) {
        const tok = (m[1] ?? '').toLowerCase();
        if (tok === '-inf') continue;
        const v = Number(tok);
        if (Number.isFinite(v) && v > best) best = v;
      }
      resolve(best);
    });
  });
}

// Cheap signal of "silent enough to be a grief submission". Returns
// true ONLY when we have a definite reading below the threshold.
//
// We FAIL-OPEN on -Infinity / NaN: ffmpeg may legitimately fail to
// decode (network blip, ACL issue on the bucket, exotic codec we don't
// expect). A genuinely silent file would still pass through, but that's
// the lesser evil - we can't false-reject every submission whenever
// ffmpeg has a bad day. The honor system catches dedicated griefers
// via the abandon path anyway (no submission = honor penalty).
export function isSilent(rmsDbFs: number, thresholdDbFs = -50): boolean {
  if (!Number.isFinite(rmsDbFs)) return false; // fail-open
  return rmsDbFs < thresholdDbFs;
}
