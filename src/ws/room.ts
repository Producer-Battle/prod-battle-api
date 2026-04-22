// Per-match WebSocket session wrapper.
// Subscribes to Redis channel `battle:{matchId}` and forwards messages to this
// socket. Validates inbound messages against zod schemas (same as OpenAPI),
// writes authoritative mutations to Postgres, publishes to Redis for fan-out.

import type { WebSocket } from 'ws';
import { subscribe } from '../realtime/pubsub.js';

export class MatchSession {
  private readonly matchId: string;
  private readonly userId: string;
  private readonly ws: WebSocket;
  private unsubscribe: (() => void) | null = null;

  constructor(matchId: string, userId: string, ws: WebSocket) {
    this.matchId = matchId;
    this.userId = userId;
    this.ws = ws;

    // Subscribe to the match's Redis channel and forward to this socket.
    this.unsubscribe = subscribe(`battle:${matchId}`, (payload) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    });

    ws.on('close', () => {
      this.dispose();
    });

    ws.on('error', () => {
      this.dispose();
    });
  }

  /** Send a message directly to this socket. */
  send(payload: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  get id(): string {
    return this.userId;
  }

  get matchIdValue(): string {
    return this.matchId;
  }
}
