import { execFile } from 'node:child_process';

export type FingerprintResult = {
  duration: number;
  fingerprint: number[];
};

// fpcalc -raw -json emits {"duration": n, "fingerprint": [int, ...]}.
// fpcalc routinely exits non-zero with "Error decoding audio frame (End of file)"
// while still producing a valid fingerprint on stdout, so we parse stdout
// regardless of exit code and only fail when there's nothing parseable.
export function fingerprintFile(path: string): Promise<FingerprintResult> {
  return new Promise((resolve, reject) => {
    execFile('fpcalc', ['-raw', '-json', path], { timeout: 30_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('fpcalc not found - install chromaprint-tools'));
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(`fpcalc failed: ${err?.message ?? 'no output'}`));
        return;
      }

      let parsed: { duration: number; fingerprint: number[] };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        reject(new Error(`fpcalc output not JSON: ${trimmed.slice(0, 200)}`));
        return;
      }
      resolve({ duration: parsed.duration, fingerprint: parsed.fingerprint });
    });
  });
}
