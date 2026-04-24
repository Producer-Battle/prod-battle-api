import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, getJson } from '../harness.js';
import { resetMatchState, seedTestFixtures } from '../seed.js';

describe('admin GET /admin/sample-packs/:id/stems', () => {
  // Fresh fixtures resolved in beforeAll; packId referenced across tests.
  let packId = '';

  beforeAll(async () => {
    const fixtures = await seedTestFixtures();
    packId = fixtures.packId;
  });

  beforeEach(async () => {
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    packId = fixtures.packId;
  });

  it('200 - returns all seeded stems with signed URLs for an admin', async () => {
    const app = buildTestApp({ asAdminUserId: randomUUID() });
    const { status, json } = await getJson<{
      items: { stemType: string; name: string; url: string; durationSec: number | null }[];
    }>(app, `/admin/sample-packs/${packId}/stems`);

    expect(status).toBe(200);
    // seed.ts inserts 4 samples: kick, snare, hihat, 808
    expect(json.items).toHaveLength(4);
    for (const item of json.items) {
      expect(typeof item.stemType).toBe('string');
      expect(item.stemType.length).toBeGreaterThan(0);
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      // The S3 presigner is mocked in setup.ts and always returns this URL.
      expect(item.url).toBe('https://s3.fake/signed?sig=test');
      // durationSec is null until transcode durations are surfaced.
      expect(item.durationSec).toBeNull();
    }
  });

  it('401 - no authentication', async () => {
    // Default buildTestApp: no user set, every admin route returns 401.
    const app = buildTestApp();
    const { status } = await getJson(app, `/admin/sample-packs/${packId}/stems`);
    expect(status).toBe(401);
  });

  it('403 - non-admin role (producer)', async () => {
    const app = buildTestApp({ asAdminUserId: randomUUID(), role: 'producer' });
    const { status } = await getJson(app, `/admin/sample-packs/${packId}/stems`);
    expect(status).toBe(403);
  });

  it('404 - non-existent pack id', async () => {
    const app = buildTestApp({ asAdminUserId: randomUUID() });
    const missingId = randomUUID();
    const { status, json } = await getJson<{ error: string; message: string }>(
      app,
      `/admin/sample-packs/${missingId}/stems`,
    );
    expect(status).toBe(404);
    expect(json.error).toBe('not_found');
  });
});
