// Redis pub/sub wrapper.
// Uses ioredis: one subscriber client per process (shared), one publisher.
// Channels: `battle:{matchId}` for match events; `queue:{genreSlug}` for
// quickplay matchmaking notifications; `system` for global admin events.

export async function publish(_channel: string, _payload: unknown): Promise<void> {
  throw new Error('not implemented');
}

export function subscribe(_channel: string, _handler: (payload: unknown) => void): () => void {
  throw new Error('not implemented');
}
