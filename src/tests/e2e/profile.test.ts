// E2E tests for GET /me, PATCH /me, POST /me/avatar/upload-url, and GET /users/:handle.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, getJson, postJson } from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

describe('profile endpoints', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  // ─── GET /me ──────────────────────────────────────────────────────────────

  it('GET /me without auth returns 401', async () => {
    const app = buildTestApp(); // no asUser
    const { status } = await getJson(app, '/me');
    expect(status).toBe(401);
  });

  it('GET /me with asUser returns that users shape', async () => {
    const u = await seedTestUser('me-test-user', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u });
    const { status, json } = await getJson<{
      id: string;
      handle: string;
      email: string;
      role: string;
      plan: string;
      status: string;
      avatarUrl: string | null;
      createdAt: string;
      stats: { totalMatches: number; totalSubmissions: number; bestRank: number | null };
    }>(app, '/me');
    expect(status).toBe(200);
    expect(json.id).toBe(u.id);
    expect(json.handle).toBe(u.handle);
    expect(json.email).toBe(u.email);
    expect(json.role).toBe('producer');
    expect(json.plan).toBe('free');
    expect(json.status).toBe('active');
    expect(json.avatarUrl).toBeNull();
    expect(typeof json.createdAt).toBe('string');
    expect(json.stats.totalMatches).toBe(0);
    expect(json.stats.totalSubmissions).toBe(0);
    expect(json.stats.bestRank).toBeNull();
  });

  // ─── PATCH /me ────────────────────────────────────────────────────────────

  it('PATCH /me with valid handle change returns 200 and updates handle', async () => {
    const u = await seedTestUser('patch-me-original', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u });

    const { status, json } = await postJson<{ handle: string }>(app, '/me', {
      handle: 'PatchedHandle',
    });
    // Hono openapi PATCH uses the method; postJson sends POST - use fetch directly
    const res = await app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'patchednew' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handle: string };
    // Handle is lowercased before save
    expect(body.handle).toBe('patchednew');
    void status; // unused first call result
    void json;
  });

  it('PATCH /me with taken handle returns 409', async () => {
    const u1 = await seedTestUser('handle-owner', { plan: 'free', role: 'producer' });
    const u2 = await seedTestUser('handle-claimant', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u2 });

    const res = await app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: u1.handle }),
    });
    expect(res.status).toBe(409);
    void u1;
  });

  it('PATCH /me with invalid handle format returns 400', async () => {
    const u = await seedTestUser('patch-invalid-fmt', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u });

    const res = await app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'x!' }), // too short + invalid char
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /me without auth returns 401', async () => {
    const app = buildTestApp();
    const res = await app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'newhandle' }),
    });
    expect(res.status).toBe(401);
  });

  // ─── GET /users/:handle ───────────────────────────────────────────────────

  it('GET /users/:handle for known user returns 200 without email', async () => {
    const u = await seedTestUser('public-profile-user', { plan: 'free', role: 'producer' });
    const app = buildTestApp();

    const { status, json } = await getJson<{
      handle: string;
      avatarUrl: string | null;
      role: string;
      bio: string | null;
      createdAt: string;
      recentSubmissions: unknown[];
      email?: string;
    }>(app, `/users/${u.handle}`);

    expect(status).toBe(200);
    expect(json.handle).toBe(u.handle);
    expect(json.role).toBe('producer');
    expect(json.bio).toBeNull();
    expect(Array.isArray(json.recentSubmissions)).toBe(true);
    // email must NOT be present in the public profile
    expect(json.email).toBeUndefined();
  });

  it('GET /users/:handle for unknown handle returns 404', async () => {
    const app = buildTestApp();
    const { status } = await getJson(app, '/users/no-such-handle-xyz');
    expect(status).toBe(404);
  });

  it('GET /users/:handle for a deleted user returns 404', async () => {
    // Seed the user and mark them deleted at DB level.
    const u = await seedTestUser('deleted-profile-user', { plan: 'free', role: 'producer' });

    const { db: getDb } = await import('../../db/client.js');
    const { users } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const d = getDb();
    await d.update(users).set({ status: 'deleted' }).where(eq(users.id, u.id));

    const app = buildTestApp();
    const { status } = await getJson(app, `/users/${u.handle}`);
    expect(status).toBe(404);
  });

  // ─── POST /me/avatar/upload-url ───────────────────────────────────────────

  it('POST /me/avatar/upload-url returns a presigned URL for image/jpeg', async () => {
    const u = await seedTestUser('avatar-upload-jpeg', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u });

    const { status, json } = await postJson<{
      uploadUrl: string;
      publicUrl: string;
      key: string;
      maxBytes: number;
    }>(app, '/me/avatar/upload-url', { contentType: 'image/jpeg' });

    expect(status).toBe(200);
    // In the test environment the AWS SDK presigner is mocked so the URL is
    // a stable fake value - just verify it is a non-empty string.
    expect(typeof json.uploadUrl).toBe('string');
    expect(json.uploadUrl.length).toBeGreaterThan(0);
    expect(json.key).toBe(`avatars/${u.id}.jpg`);
    expect(json.publicUrl).toContain(`avatars/${u.id}.jpg`);
    expect(json.maxBytes).toBe(2 * 1024 * 1024);
  });

  it('POST /me/avatar/upload-url rejects unsupported content type with 400', async () => {
    const u = await seedTestUser('avatar-upload-pdf', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u });

    const { status } = await postJson(app, '/me/avatar/upload-url', {
      contentType: 'application/pdf',
    });

    expect(status).toBe(400);
  });

  // ─── PATCH /me with bio + socialLinks ─────────────────────────────────────

  it('PATCH /me with bio + socialLinks persists and returns them on GET /me', async () => {
    const u = await seedTestUser('bio-social-user', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u });

    // Patch with bio and socialLinks.
    const patchRes = await app.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bio: 'Making beats since 2010.',
        socialLinks: {
          spotify: 'https://open.spotify.com/artist/test',
          soundcloud: 'https://soundcloud.com/test',
        },
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      bio: string | null;
      socialLinks: Record<string, string>;
    };
    expect(patchBody.bio).toBe('Making beats since 2010.');
    expect(patchBody.socialLinks.spotify).toBe('https://open.spotify.com/artist/test');
    expect(patchBody.socialLinks.soundcloud).toBe('https://soundcloud.com/test');

    // Verify persistence via GET /me.
    const { status, json } = await getJson<{
      bio: string | null;
      socialLinks: Record<string, string>;
    }>(app, '/me');
    expect(status).toBe(200);
    expect(json.bio).toBe('Making beats since 2010.');
    expect(json.socialLinks.spotify).toBe('https://open.spotify.com/artist/test');
  });

  // ─── GET /users/:handle returns bio + socialLinks ─────────────────────────

  it('GET /users/:handle returns bio + socialLinks publicly', async () => {
    const u = await seedTestUser('public-bio-user', { plan: 'free', role: 'producer' });
    const ownerApp = buildTestApp({ asUser: u });

    // Set bio and socialLinks via PATCH as the owner.
    const patchRes = await ownerApp.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bio: 'Public bio text.',
        socialLinks: { website: 'https://example.com' },
      }),
    });
    expect(patchRes.status).toBe(200);

    // Fetch the public profile as an anonymous visitor.
    const anonApp = buildTestApp();
    const { status, json } = await getJson<{
      handle: string;
      bio: string | null;
      socialLinks: Record<string, string>;
      email?: string;
    }>(anonApp, `/users/${u.handle}`);

    expect(status).toBe(200);
    expect(json.bio).toBe('Public bio text.');
    expect(json.socialLinks.website).toBe('https://example.com');
    // email must still not be present on public profiles.
    expect(json.email).toBeUndefined();
  });

  // ─── GET /me with no producer_profile row returns graceful defaults ────────

  it('GET /me with no producer_profile row returns bio: null and socialLinks: {}', async () => {
    const u = await seedTestUser('no-profile-user', { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: u });

    const { status, json } = await getJson<{
      bio: string | null;
      socialLinks: Record<string, string>;
    }>(app, '/me');

    expect(status).toBe(200);
    expect(json.bio).toBeNull();
    expect(json.socialLinks).toEqual({});
  });
});
