// E2E tests for the WAV quality gate on GET /matches/:code/sample-pack/zip?format=wav.
//
// format=wav requires plan='paid' or role='admin'.
// format=mp3 (or omitted) is allowed for everyone.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { buildTestApp, getJson, uniqueHandle } from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

describe('WAV download gate', () => {
  let roomCode = '';

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    const { genreId, packId } = await seedTestFixtures();

    // Give the pool pack a zipUrl so the route has a fast-path response.
    await db().execute(
      sql`UPDATE sample_packs SET zip_url = 'http://localhost:9000/pb-test/zips/test.zip' WHERE id = ${packId}`,
    );

    // Create a match tied to that pack.
    roomCode = `WAVTEST${randomUUID().slice(0, 4).toUpperCase()}`;
    await db().execute(sql`
      INSERT INTO matches
        (id, mode, status, room_code, team_size, team_count, primary_genre_id,
         sample_mode, sample_pack_id)
      VALUES
        (${randomUUID()}, 'quickplay', 'lobby', ${roomCode}, 1, 8, ${genreId},
         'generated', ${packId})
    `);
  });

  it('format=wav returns 402 for anonymous user', async () => {
    const app = buildTestApp(); // anon
    const { status, json } = await getJson<{ error: string }>(
      app,
      `/matches/${roomCode}/sample-pack/zip?format=wav`,
    );
    expect(status).toBe(402);
    expect((json as { error: string }).error).toBe('paid_feature');
  });

  it('format=wav returns 402 for free authenticated producer', async () => {
    const freeUser = await seedTestUser(uniqueHandle('wav-free'), {
      plan: 'free',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: freeUser });
    const { status, json } = await getJson<{ error: string }>(
      app,
      `/matches/${roomCode}/sample-pack/zip?format=wav`,
    );
    expect(status).toBe(402);
    expect((json as { error: string }).error).toBe('paid_feature');
  });

  it('format=wav returns 200 for paid producer', async () => {
    const paidUser = await seedTestUser(uniqueHandle('wav-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: paidUser });
    const { status } = await getJson(app, `/matches/${roomCode}/sample-pack/zip?format=wav`);
    expect(status).toBe(200);
  });

  it('format=wav returns 200 for admin (any plan)', async () => {
    const adminUser = await seedTestUser(uniqueHandle('wav-admin'), {
      plan: 'free',
      role: 'admin',
    });
    const app = buildTestApp({ asUser: adminUser });
    const { status } = await getJson(app, `/matches/${roomCode}/sample-pack/zip?format=wav`);
    expect(status).toBe(200);
  });

  it('format=mp3 (default) returns 200 for anonymous user', async () => {
    const app = buildTestApp(); // anon
    const { status } = await getJson(app, `/matches/${roomCode}/sample-pack/zip?format=mp3`);
    expect(status).toBe(200);
  });

  it('no format param returns 200 for anonymous user (default mp3)', async () => {
    const app = buildTestApp(); // anon
    const { status } = await getJson(app, `/matches/${roomCode}/sample-pack/zip`);
    expect(status).toBe(200);
  });
});
