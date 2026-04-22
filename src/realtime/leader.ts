// Redis-based leader election.
// Pattern: SET leader:tick <id> NX EX 5; renew every 2s while alive.
// On loss (renew fails), handler stops calling the tick loop.

export async function runAsLeader(
  _key: string,
  _onBecomeLeader: () => Promise<void>,
): Promise<void> {
  throw new Error('not implemented');
}
