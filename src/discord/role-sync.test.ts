// Unit tests for the Discord supporter role-sync module.
//
// Strategy: test the no-op path when env vars are missing, and mock fetch
// to verify the grant/revoke API call shape when env is present.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── DB mock ─────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();

vi.mock('../db/client.js', () => ({
  db: () => ({
    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => mockSelect(),
        }),
      }),
    }),
  }),
}));

// ─── Schema mock (accounts table) ─────────────────────────────────────────────

vi.mock('../db/schema.js', () => ({
  accounts: { userId: 'userId', providerId: 'providerId' },
}));

// ─── Drizzle eq/and mock ─────────────────────────────────────────────────────

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, _val: unknown) => `eq(${String(_val)})`,
  and: (...args: unknown[]) => args.join(' AND '),
}));

// ─── Env mock ────────────────────────────────────────────────────────────────

const mockEnv: Record<string, string | undefined> = {};

vi.mock('../env.js', () => ({
  env: new Proxy(mockEnv, {
    get: (_t, k: string) => mockEnv[k],
  }),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('syncSupporterRole', () => {
  beforeEach(() => {
    // Clear env and mocks between tests.
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    mockSelect.mockReset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Re-import to reset the startup-log flag.
    const { _resetStartupLogForTest } = await import('./role-sync.js');
    _resetStartupLogForTest();
  });

  it('is a no-op when Discord env vars are missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { syncSupporterRole } = await import('./role-sync.js');

    await syncSupporterRole('user-123', true);

    // fetch should never have been called.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs once at startup when env vars are missing', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { syncSupporterRole, _resetStartupLogForTest } = await import('./role-sync.js');
    _resetStartupLogForTest();

    await syncSupporterRole('user-abc', false);
    await syncSupporterRole('user-abc', false);

    // Should log exactly once even if called multiple times.
    const discordLogs = consoleSpy.mock.calls.filter((c) => String(c[0]).includes('[discord]'));
    expect(discordLogs.length).toBe(1);
  });

  it('calls PUT to grant role when env is fully configured and Discord account is linked', async () => {
    mockEnv.DISCORD_BOT_TOKEN = 'token.here';
    mockEnv.DISCORD_GUILD_ID = 'guild123';
    mockEnv.DISCORD_SUPPORTER_ROLE_ID = 'role456';

    // Simulate a linked Discord account row being returned.
    mockSelect.mockResolvedValue([{ accountId: 'discord-user-999' }]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
    } as Response);

    const { syncSupporterRole } = await import('./role-sync.js');
    await syncSupporterRole('platform-user-1', true);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/guilds/guild123/members/discord-user-999/roles/role456');
    expect((init as RequestInit).method).toBe('PUT');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bot token.here');
  });

  it('calls DELETE to revoke role when plan flips to free', async () => {
    mockEnv.DISCORD_BOT_TOKEN = 'token.here';
    mockEnv.DISCORD_GUILD_ID = 'guild123';
    mockEnv.DISCORD_SUPPORTER_ROLE_ID = 'role456';

    mockSelect.mockResolvedValue([{ accountId: 'discord-user-999' }]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
    } as Response);

    const { syncSupporterRole } = await import('./role-sync.js');
    await syncSupporterRole('platform-user-1', false);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('is a no-op when user has no linked Discord account', async () => {
    mockEnv.DISCORD_BOT_TOKEN = 'token.here';
    mockEnv.DISCORD_GUILD_ID = 'guild123';
    mockEnv.DISCORD_SUPPORTER_ROLE_ID = 'role456';

    // No Discord account linked.
    mockSelect.mockResolvedValue([]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { syncSupporterRole } = await import('./role-sync.js');
    await syncSupporterRole('platform-user-no-discord', true);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
