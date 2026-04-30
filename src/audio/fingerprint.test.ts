import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintFile } from './fingerprint.js';

const fpcalcAvailable = (() => {
  try {
    execSync('which fpcalc', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('fingerprintFile', () => {
  const dir = join(tmpdir(), 'pb-fp-test');
  const fixturePath = join(dir, 'sine440.wav');

  beforeAll(() => {
    if (!fpcalcAvailable) return;
    mkdirSync(dir, { recursive: true });
    // 5-second 440 Hz sine wave, mono, 22050 Hz - smallest valid fixture.
    execSync(
      `ffmpeg -y -f lavfi -i "sine=frequency=440:duration=5" -ac 1 -ar 22050 "${fixturePath}"`,
      { stdio: 'ignore' },
    );
  });

  afterAll(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!fpcalcAvailable)(
    'returns a non-empty fingerprint array and a positive duration',
    async () => {
      const result = await fingerprintFile(fixturePath);
      expect(result.duration).toBeGreaterThan(0);
      expect(result.fingerprint.length).toBeGreaterThan(0);
      // A 5-second track at default fpcalc sample rate produces ~10-30 ints.
      expect(result.fingerprint.length).toBeGreaterThan(5);
      for (const v of result.fingerprint) {
        expect(Number.isInteger(v)).toBe(true);
      }
    },
  );

  it.skipIf(!fpcalcAvailable)('same file fingerprinted twice returns equal arrays', async () => {
    const a = await fingerprintFile(fixturePath);
    const b = await fingerprintFile(fixturePath);
    expect(a.fingerprint).toEqual(b.fingerprint);
    expect(a.duration).toBeCloseTo(b.duration, 1);
  });

  it('throws a clear error on missing binary', async () => {
    // Only meaningful when fpcalc is actually absent; skip when present.
    if (fpcalcAvailable) return;
    await expect(fingerprintFile('/tmp/nonexistent.wav')).rejects.toThrow(/fpcalc not found/);
  });
});
