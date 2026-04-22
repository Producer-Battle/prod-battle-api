// WebSocket upgrade entry point.
// Wires /ws/match/:id upgrades onto the HTTP server from server.ts.
// Auth: reads session cookie, asserts user is a match_player for :id.
// Delegates to ./room.ts for per-match session handling.

export function attachWebSocket(/* server: Server */): void {
  throw new Error('not implemented');
}
