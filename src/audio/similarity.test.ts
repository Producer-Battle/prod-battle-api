import { describe, expect, it } from 'vitest';
import { similarity } from './similarity.js';

describe('similarity', () => {
  it('identical fingerprints return 1.0', () => {
    const fp = [0x1234abcd, 0xdeadbeef, 0x00ff00ff, 0xaaaaaaaa];
    expect(similarity(fp, fp)).toBe(1.0);
  });

  it('identical long fingerprints return 1.0', () => {
    const fp = Array.from({ length: 100 }, (_, i) => i * 1234567);
    expect(similarity(fp, fp)).toBe(1.0);
  });

  it('one bit flipped per element stays close to 1.0', () => {
    const a = Array.from({ length: 100 }, (_, i) => i * 7919);
    const b = a.map((v) => v ^ 1);
    const s = similarity(a, b);
    // 1 bit flipped out of 32 per element -> BER = 1/32 = 0.03125, sim = 0.96875
    expect(s).toBeCloseTo(0.96875, 4);
  });

  it('completely random integers yield ~0.5 similarity', () => {
    // Use two different deterministic but uncorrelated sequences.
    // XOR of two independent uniform random vars is uniform random,
    // so popcount / 32 averages to 0.5 and similarity -> ~0.5.
    const a = Array.from({ length: 300 }, (_, i) => Math.imul(i + 1, 0x9e3779b9));
    const b = Array.from({ length: 300 }, (_, i) => Math.imul(i + 1, 0x6c62272e));
    const s = similarity(a, b);
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.6);
  });

  it('small time-shift (offset within window) gives high similarity', () => {
    const base = Array.from({ length: 120 }, (_, i) => Math.imul(i, 0x9e3779b9) ^ 0x55aa55aa);
    // Shift by 2 elements (within the OFFSET_WINDOW of 3).
    const shifted = base.slice(2);
    const s = similarity(base, shifted);
    expect(s).toBeGreaterThan(0.9);
  });

  it('handles length mismatch gracefully', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 2, 3];
    const s = similarity(a, b);
    // Comparison is only over the overlapping region.
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('empty arrays return 0', () => {
    expect(similarity([], [1, 2, 3])).toBe(0);
    expect(similarity([1, 2, 3], [])).toBe(0);
    expect(similarity([], [])).toBe(0);
  });

  it('completely different audio fingerprints score below 0.7', () => {
    // Two very different bit patterns - alternating 0/all-ones vs sequential.
    const a = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0 : 0xffffffff));
    const b = Array.from({ length: 200 }, (_, i) => Math.imul(i + 1000, 0x6c62272e));
    const s = similarity(a, b);
    expect(s).toBeLessThan(0.7);
  });
});
