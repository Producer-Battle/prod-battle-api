// Quick Play + Ranked matchmaking queue.
// Redis sorted set per (genre, mode) keyed by user_id, score = join_ms.
// Matcher sweeps queues every 500ms, pairs by size/glicko band, creates a
// match row and publishes `match_found` to each user's personal channel.

export type QueueKey = { genreSlug: string; mode: 'quickplay' | 'ranked'; teamSize: number };

export async function enqueue(_userId: string, _key: QueueKey): Promise<void> {
  throw new Error('not implemented');
}

export async function dequeue(_userId: string, _key: QueueKey): Promise<void> {
  throw new Error('not implemented');
}
