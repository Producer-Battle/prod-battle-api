// Real-S3 integration tests.
// These tests require a running S3-compatible endpoint (MinIO in dev/CI) and
// a running Postgres DB. They upload real bytes, exercise the API routes,
// and assert that the signed URLs returned by the API are actually fetchable
// and return the expected byte content.
//
// Do NOT import src/tests/setup.ts here - we want real ioredis and real S3
// presigner, not mocks.

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucket, publicUrl, putObject, s3 } from '../../audio/s3.js';
import { db } from '../../db/client.js';
import { flipSources, samplePacks } from '../../db/schema.js';
import { buildTestApp, createMatch, getJson, getMatch } from '../harness.js';
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures } from '../seed.js';

// A minimal 44-byte WAV header (PCM, mono, 44100 Hz, 16-bit, 0 data bytes).
// Only needs to be a stable byte pattern - not valid audio, just verifiable.
const WAV_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

// Keys uploaded by this test suite - cleaned up in afterAll.
const uploadedKeys: string[] = [];

async function uploadWav(key: string): Promise<string> {
  uploadedKeys.push(key);
  return putObject(key, WAV_HEADER, 'audio/wav');
}

describe('asset round-trip (real S3)', () => {
  const app = buildTestApp();

  let flipSourceId: string;
  let packId: string;
  let stemKeys: string[];

  beforeAll(async () => {
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    flipSourceId = fixtures.flipSourceId;
    packId = fixtures.packId;
    const d = db();

    // Upload a real flip WAV and point the seeded flip_source at it.
    const flipKey = 'flips/integration-test-flip.wav';
    await uploadWav(flipKey);
    const flipUrl = publicUrl(flipKey);
    await d.update(flipSources).set({ url: flipUrl }).where(eq(flipSources.id, flipSourceId));

    // Upload real stem WAVs and overwrite the seeded pool pack's samples JSONB.
    const stemDefs = [
      { stemType: 'kick', name: 'kick-it' },
      { stemType: 'snare', name: 'snare-it' },
    ];
    stemKeys = stemDefs.map((s) => `stems/integration-test-${s.stemType}.wav`);
    for (const key of stemKeys) {
      await uploadWav(key);
    }
    const samples = stemDefs.map((s, i) => ({
      stemType: s.stemType,
      name: s.name,
      url: publicUrl(stemKeys[i] as string),
    }));
    await d.update(samplePacks).set({ samples }).where(eq(samplePacks.id, packId));
  });

  afterAll(async () => {
    // Clean up all objects uploaded by this suite.
    for (const key of uploadedKeys) {
      try {
        await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      } catch {
        // Best-effort cleanup - don't fail the suite on cleanup errors.
      }
    }
  });

  it('GET /matches/:code returns a flipSource.url that serves the uploaded bytes', async () => {
    const match = await createMatch(app, {
      mode: 'flip',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 2,
    });
    expect(match.flipSource).not.toBeNull();

    const fetched = await getMatch(app, match.roomCode);
    expect(fetched.flipSource).not.toBeNull();

    const url = fetched.flipSource?.url;
    expect(url).toBeDefined();

    const res = await fetch(url as string);
    expect(res.status).toBe(200);

    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(WAV_HEADER);
  });

  it('GET /flip-sources returns urls that serve the uploaded bytes', async () => {
    const { json } = await getJson<{ items: { id: string; url: string }[] }>(app, '/flip-sources');
    expect(json.items.length).toBeGreaterThan(0);

    for (const item of json.items) {
      const res = await fetch(item.url);
      expect(res.status).toBe(200);
    }
  });

  it('GET /matches/:code returns samplePack sample urls that serve the uploaded bytes', async () => {
    // Quickplay (or ranked/private/tournament/daily) auto-generates a pack
    // and links it to the match via samplePackId. flip mode is INTENTIONALLY
    // excluded - it ships only the flip source loop and never a kit
    // (matchmaking/defaults.ts:DEFAULT_SAMPLE_MODE.flip = 'none').
    const match = await createMatch(app, {
      mode: 'quickplay',
      genreSlug: TEST_GENRE_SLUG,
      teamSize: 1,
      teamCount: 2,
    });

    // GET /matches/:code always returns the full pack payload regardless of
    // whether the POST response was a lobby-join (which returns samplePack: null).
    const fetched = await getMatch(app, match.roomCode);
    expect(fetched.samplePack).not.toBeNull();

    const samples = (fetched as unknown as { samplePack: { samples: { url: string }[] } | null })
      .samplePack?.samples;
    expect(samples).toBeDefined();
    expect((samples ?? []).length).toBeGreaterThan(0);

    for (const sample of samples ?? []) {
      const res = await fetch(sample.url);
      expect(res.status).toBe(200);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body).toEqual(WAV_HEADER);
    }
  });
});
