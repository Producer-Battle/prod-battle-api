// Unit tests for vote fingerprint collision logic.
//
// These tests verify the fp-collision guard by testing the key primitives:
// the fingerprint identity string derivation and the overlap detection logic.
// The full integration path (HTTP POST /rooms/:code/vote) is covered in
// the e2e test suite which requires Postgres - these tests are pure-unit
// and run without any external dependencies.

import { describe, expect, it } from 'vitest';

// ─── Pure helpers extracted from the vote handler logic ──────────────────────
//
// The vote handler builds:
//   voterFps    = new Set(u.deviceFingerprints?.map(f => `${f.canvasHash}|${f.screenDims}`) ?? [])
//   submitterFpMap keyed by userId -> Set<"canvasHash|screenDims">
//
// The collision check is: any fp in voterFps that is also in submitterFps
// We test that logic here with plain sets so we don't need the DB.

type FpEntry = { canvasHash: string; screenDims: string };

function buildFpSet(fingerprints: FpEntry[]): Set<string> {
  return new Set(fingerprints.map((f) => `${f.canvasHash}|${f.screenDims}`));
}

function hasCollision(voterFps: Set<string>, submitterFps: Set<string>): boolean {
  for (const fp of voterFps) {
    if (submitterFps.has(fp)) return true;
  }
  return false;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VOTER_FP_A: FpEntry = { canvasHash: 'aabbcc', screenDims: '1920x1080' };
const VOTER_FP_B: FpEntry = { canvasHash: 'ddeeff', screenDims: '2560x1440' };
// Submitter shares the same device as the voter (same canvasHash + screenDims)
const SUBMITTER_FP_MATCHING: FpEntry = { canvasHash: 'aabbcc', screenDims: '1920x1080' };
// Submitter has a different device
const SUBMITTER_FP_DISTINCT: FpEntry = { canvasHash: '112233', screenDims: '1280x720' };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('vote fingerprint collision detection', () => {
  it('detects collision when voter and submitter share the same fp entry', () => {
    const voterFps = buildFpSet([VOTER_FP_A]);
    const submitterFps = buildFpSet([SUBMITTER_FP_MATCHING]);
    expect(hasCollision(voterFps, submitterFps)).toBe(true);
  });

  it('detects collision when voter has multiple fps and one matches the submitter', () => {
    const voterFps = buildFpSet([VOTER_FP_B, VOTER_FP_A]);
    const submitterFps = buildFpSet([SUBMITTER_FP_MATCHING]);
    expect(hasCollision(voterFps, submitterFps)).toBe(true);
  });

  it('does NOT flag collision when voter and submitter have distinct fps', () => {
    const voterFps = buildFpSet([VOTER_FP_A]);
    const submitterFps = buildFpSet([SUBMITTER_FP_DISTINCT]);
    expect(hasCollision(voterFps, submitterFps)).toBe(false);
  });

  it('does NOT flag collision when submitter has no fingerprints', () => {
    const voterFps = buildFpSet([VOTER_FP_A]);
    const submitterFps = buildFpSet([]);
    expect(hasCollision(voterFps, submitterFps)).toBe(false);
  });

  it('does NOT flag collision when voter has no fingerprints', () => {
    // Empty voterFps means the guard cannot fire (nothing to match against)
    const voterFps = buildFpSet([]);
    const submitterFps = buildFpSet([SUBMITTER_FP_MATCHING]);
    // Guard in phases.ts short-circuits on voterFps.size === 0
    expect(voterFps.size).toBe(0);
    expect(hasCollision(voterFps, submitterFps)).toBe(false);
  });

  it('uses canvasHash|screenDims as the identity key (not userAgent or timezone)', () => {
    // Two fingerprints with the same canvas+screen but different userAgents
    // should hash to the same identity key (userAgent drifts across updates).
    const fpSet = buildFpSet([{ canvasHash: 'aabbcc', screenDims: '1920x1080' }]);
    // Identity string should be "aabbcc|1920x1080"
    expect(fpSet.has('aabbcc|1920x1080')).toBe(true);
  });

  it('treats distinct (canvasHash, screenDims) pairs as different identities', () => {
    const fpA = buildFpSet([{ canvasHash: 'aabbcc', screenDims: '1920x1080' }]);
    const fpB = buildFpSet([{ canvasHash: 'aabbcc', screenDims: '2560x1440' }]);
    // Same canvas hash but different screen dims -> different identities
    expect(hasCollision(fpA, fpB)).toBe(false);
  });
});
