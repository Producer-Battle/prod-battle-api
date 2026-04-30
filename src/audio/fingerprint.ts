import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type FingerprintResult = {
  duration: number;
  fingerprint: number[];
};

// fpcalc -raw outputs fingerprint as a comma-separated list of signed 32-bit ints.
// This avoids the base64/compressed encoding that the default output uses.
export async function fingerprintFile(path: string): Promise<FingerprintResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('fpcalc', ['-raw', '-json', path], {
      timeout: 30_000,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      throw new Error('fpcalc not found - install chromaprint-tools');
    }
    throw new Error(`fpcalc failed: ${msg}`);
  }

  const parsed = JSON.parse(stdout) as { duration: number; fingerprint: string };
  const fingerprint = parsed.fingerprint.split(',').map((s) => Number.parseInt(s, 10));

  return { duration: parsed.duration, fingerprint };
}
