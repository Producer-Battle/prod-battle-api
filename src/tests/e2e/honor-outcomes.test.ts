// Outcome accounting: applyMatchOutcome runs at results entry. Verify
// every clean completer gets completed_at + honor regen, while honor is
// clamped to [0, 100]. Failures-to-submit and grace-timeout abandons get
// covered alongside the WS heartbeat tests in a follow-up.

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { matchPlayers, users } from '../../db/schema.js';
import {
  buildTestApp,
  createMatch,
  getMatch,
  getResults,
  getReveal,
  joinRoom,
  startRoom,
  submitTrack,
  uniqueHandle,
  voteForAll,
} from '../harness.js';
import { resetMatchState, seedTestFixtures } from '../seed.js';

describe('honor outcomes', () => {
  const app = buildTestApp();

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
  });

  it('clean completers get completedAt + honor delta; honor stays capped at 100', async () => {
    const match = await createMatch(app, { mode: 'quickplay' });
    const handles = Array.from({ length: 4 }, (_, i) => uniqueHandle(`hr-${i}`));
    for (const h of handles) await joinRoom(app, match.roomCode, h);
    const host = handles[0];
    if (!host) throw new Error('no host');
    await startRoom(app, match.roomCode, host);

    const ownByHandle = new Map<string, string>();
    for (const h of handles) ownByHandle.set(h, await submitTrack(app, match.roomCode, h));

    const items = await getReveal(app, match.roomCode);
    for (const h of handles) {
      await voteForAll(app, match.roomCode, h, ownByHandle.get(h) ?? null, items);
    }
    await getResults(app, match.roomCode);

    const m = await getMatch(app, match.roomCode);
    expect(m.status).toBe('results');

    const rows = await db()
      .select({
        userId: matchPlayers.userId,
        completedAt: matchPlayers.completedAt,
        abandoned: matchPlayers.abandoned,
        honorDelta: matchPlayers.honorDelta,
      })
      .from(matchPlayers)
      .where(eq(matchPlayers.matchId, m.id));
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.abandoned).toBe(false);
      expect(r.completedAt).not.toBeNull();
      expect(r.honorDelta).toBe(1);
    }

    const honors = await db()
      .select({ honor: users.honor })
      .from(users)
      .where(eq(users.handle, host));
    expect(honors[0]?.honor).toBeLessThanOrEqual(100);
    expect(honors[0]?.honor).toBeGreaterThan(0);
  });
});
