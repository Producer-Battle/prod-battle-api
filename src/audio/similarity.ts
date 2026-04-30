// Bit-error-rate similarity between two Chromaprint fingerprint arrays.
// Tries a small offset window to handle minor timing differences between
// recordings (e.g. different silence at the start). Returns 1 - min_BER,
// so identical fingerprints yield 1.0 and random ones yield ~0.5.

const OFFSET_WINDOW = 3;

function popcount(n: number): number {
  // Kernighan's method. The >>> 0 coerces to unsigned 32-bit first so
  // negative JS numbers (which fpcalc emits as signed 32-bit ints) work
  // correctly.
  let x = n >>> 0;
  let count = 0;
  while (x !== 0) {
    x &= x - 1;
    count++;
  }
  return count;
}

function ber(a: number[], b: number[], offsetB: number): number {
  const startA = Math.max(0, -offsetB);
  const startB = Math.max(0, offsetB);
  const len = Math.min(a.length - startA, b.length - startB);
  if (len <= 0) return 1;

  let bits = 0;
  for (let i = 0; i < len; i++) {
    bits += popcount((a[startA + i] as number) ^ (b[startB + i] as number));
  }
  return bits / (len * 32);
}

export function similarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  let minBer = 1;
  for (let off = -OFFSET_WINDOW; off <= OFFSET_WINDOW; off++) {
    const e = ber(a, b, off);
    if (e < minBer) minBer = e;
  }
  return 1 - minBer;
}
