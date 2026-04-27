// Honor gates - middleware factory rejecting users whose honor is below
// the configured threshold for an action. Thresholds are admin-tunable
// via game_rules.honor.gates.
//
// Usage:
//   route.middleware(requireHonor('ranked'))
//
// Rejection shape: 403 with { error: 'low_honor', message, currentHonor,
// requiredHonor }. The frontend can show "your honor (35) is too low for
// ranked (50 required) - play some clean quickplay matches to recover".

import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getCategory } from '../game-rules/loader.js';

export type HonorGate = 'tournament' | 'ranked' | 'privateHosting' | 'readOnly';

export function requireHonor(gate: HonorGate) {
  return createMiddleware(async (c, next) => {
    const user = c.var.user as { id: string } | null | undefined;
    if (!user) return next(); // unauthenticated handling lives in the route

    const honorRules = await getCategory('honor');

    let threshold: number;
    if (gate === 'readOnly') threshold = honorRules.gates.readOnlyBelow;
    else if (gate === 'tournament') threshold = honorRules.gates.tournament;
    else if (gate === 'ranked') threshold = honorRules.gates.ranked;
    else threshold = honorRules.gates.privateHosting;

    const [row] = await db()
      .select({ honor: users.honor })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const currentHonor = row?.honor ?? honorRules.start;

    if (gate === 'readOnly') {
      // Special: readOnly is a "below this honor, deny ALL writes" gate.
      // Pass through if honor >= threshold; deny otherwise.
      if (currentHonor < threshold) {
        return c.json(
          {
            error: 'read_only',
            message:
              'Your honor is too low to create matches. Vote, watch, and play clean quickplay to recover.',
            currentHonor,
            requiredHonor: threshold,
          },
          403,
        );
      }
      return next();
    }

    if (currentHonor < threshold) {
      return c.json(
        {
          error: 'low_honor',
          message: `Honor too low for ${gate}. You have ${currentHonor}, need ${threshold}. Play some clean matches to recover.`,
          currentHonor,
          requiredHonor: threshold,
        },
        403,
      );
    }

    return next();
  });
}
