// Per-match WebSocket session wrapper.
// Subscribes to Redis channel `battle:{matchId}` and forwards messages to this
// socket. Validates inbound messages against zod schemas (same as OpenAPI),
// writes authoritative mutations to Postgres, publishes to Redis for fan-out.

export class MatchSession {
  constructor(_matchId: string, _userId: string) {
    throw new Error('not implemented');
  }
}
