// Anti-smurf account-cluster guard for ranked matchmaking.
//
// Two accounts created from the same /24 IP block are likely the same
// person (or roommates) and shouldn't be matched against each other in
// ranked - it gives one of them a free win whenever the cluster queues
// together. We pull the most recent session IP per user and compare /24
// prefixes.
//
// Soft signal: only blocks ranked matchmaking. Same-cluster players can
// still play together in private rooms, quickplay, etc.

import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

function ipv4ToCluster(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // Strip port + IPv6 brackets if any.
  const clean = ip.replace(/^\[?|\]?(:\d+)?$/g, '').trim();
  // IPv4: take the /24.
  const m4 = clean.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  if (m4) return `${m4[1]}.${m4[2]}.${m4[3]}.0/24`;
  // IPv6: take /48 (first 3 hex groups). Loose match.
  const m6 = clean.match(/^([0-9a-fA-F:]+)$/);
  if (m6) {
    const groups = clean.split(':');
    if (groups.length >= 3) return `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
  }
  return null;
}

async function lastSeenCluster(userId: string): Promise<string | null> {
  const [row] = await db()
    .select({ ip: sessions.ipAddress })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return ipv4ToCluster(row?.ip ?? null);
}

async function fingerprintHashes(userId: string): Promise<Set<string>> {
  const [u] = await db()
    .select({ list: users.deviceFingerprints })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const set = new Set<string>();
  for (const f of u?.list ?? []) {
    // canvasHash + screenDims is the strongest signal - userAgent
    // varies more across sessions of the same device.
    set.add(`${f.canvasHash}|${f.screenDims}`);
  }
  return set;
}

/**
 * Check whether this user shares a cluster (IP /24 OR canvas+screen
 * fingerprint) with any other seated (non-spectator, not-yet-abandoned)
 * player in the given match.
 *
 * Returns true if a cluster collision was found = "don't seat".
 */
export async function isClusterMatch(matchId: string, userId: string): Promise<boolean> {
  const myCluster = await lastSeenCluster(userId);
  const myFingerprints = await fingerprintHashes(userId);

  const rows = await db().execute<{ user_id: string; ip: string | null }>(
    sql`SELECT mp.user_id, (
            SELECT s.ip_address
              FROM sessions s
             WHERE s.user_id = mp.user_id
             ORDER BY s.created_at DESC
             LIMIT 1
          ) AS ip
          FROM match_players mp
         WHERE mp.match_id = ${matchId}
           AND mp.is_spectator = false
           AND mp.user_id != ${userId}
           AND mp.abandoned = false`,
  );
  for (const row of rows as Array<{ user_id: string; ip: string | null }>) {
    if (myCluster) {
      const otherCluster = ipv4ToCluster(row.ip);
      if (otherCluster && otherCluster === myCluster) return true;
    }
    if (myFingerprints.size > 0) {
      const otherFp = await fingerprintHashes(row.user_id);
      for (const fp of otherFp) {
        if (myFingerprints.has(fp)) return true;
      }
    }
  }
  return false;
}

// Test-only: no internal state to reset, but exported for symmetry with
// other modules.
export const _ipv4ToClusterForTest = ipv4ToCluster;
