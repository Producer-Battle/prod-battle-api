// Discord supporter role sync - perk #2.
//
// STATUS: feature is COMPLETE on the code side but INTENTIONALLY DORMANT in
// prod (as of 2026-04-28). The bot, guild, and role IDs are not set in
// prod-battle-infra/.env, so the module logs once at startup and skips
// every invocation. To activate later: create a Discord bot with
// MANAGE_ROLES, invite to the guild, set the 3 TF_VAR_discord_* values,
// `tofu apply`, and the next plan flip will start granting/revoking the
// role. No code changes needed when reactivating.
//
// When all three env vars ARE set, syncSupporterRole() grants or revokes
// the supporter role in the configured Discord server. The function is
// best-effort: it logs on failure but never throws, so a Discord outage
// does not affect billing or plan transitions.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { env } from '../env.js';

const DISCORD_API = 'https://discord.com/api/v10';

// Log once at startup if Discord is not configured.
let _startupLogged = false;

function isConfigured(): boolean {
  return Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID && env.DISCORD_SUPPORTER_ROLE_ID);
}

function maybeLogMissing(): void {
  if (_startupLogged) return;
  _startupLogged = true;
  if (!isConfigured()) {
    console.info(
      '[discord] Supporter role sync disabled - set DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, ' +
        'and DISCORD_SUPPORTER_ROLE_ID to enable.',
    );
  }
}

// Reset the startup-log flag for tests so each test case can verify logging.
export function _resetStartupLogForTest(): void {
  _startupLogged = false;
}

/**
 * Grant or revoke the supporter Discord role for a platform user.
 * Best-effort: logs errors, never throws.
 *
 * @param userId   The platform user ID (UUID).
 * @param grant    true = grant the role, false = revoke it.
 */
export async function syncSupporterRole(userId: string, grant: boolean): Promise<void> {
  maybeLogMissing();

  if (!isConfigured()) return;

  // isConfigured() already guarantees all three are set.
  const token = env.DISCORD_BOT_TOKEN as string;
  const guildId = env.DISCORD_GUILD_ID as string;
  const roleId = env.DISCORD_SUPPORTER_ROLE_ID as string;

  try {
    // Look up the linked Discord account from the accounts table.
    const d = db();
    const [account] = await d
      .select({ accountId: accounts.accountId })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'discord')))
      .limit(1);

    if (!account) {
      // User has no linked Discord account - nothing to sync.
      return;
    }

    const discordUserId = account.accountId;
    const method = grant ? 'PUT' : 'DELETE';
    const url = `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => '(no body)');
      console.warn(
        `[discord] Failed to ${grant ? 'grant' : 'revoke'} supporter role for Discord user ` +
          `${discordUserId}: HTTP ${res.status} ${body}`,
      );
    } else {
      console.info(
        `[discord] ${grant ? 'Granted' : 'Revoked'} supporter role for Discord user ${discordUserId}`,
      );
    }
  } catch (err) {
    console.error('[discord] syncSupporterRole error:', (err as Error).message);
  }
}
