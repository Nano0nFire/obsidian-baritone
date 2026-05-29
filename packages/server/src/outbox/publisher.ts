import type WebSocket from 'ws';
import type { AppliedOp, ServerMessage } from '@obsidian-sync/shared';
import type { InMemoryDataStore } from '../engine/store.js';

export interface ClientSocket {
  vaultId: string;
  deviceId: string;
  socket: WebSocket;
}

export class OutboxPublisher {
  private readonly clients = new Map<string, ClientSocket>();
  constructor(private readonly store: InMemoryDataStore) {}

  register(client: ClientSocket): () => void {
    this.clients.set(client.deviceId, client);
    return () => this.clients.delete(client.deviceId);
  }

  async publishPending(): Promise<number> {
    let count = 0;
    for (const row of this.store.outbox) {
      if (row.published) continue;
      this.fanout(row.vaultId, { t: 'ops', ops: [row.payload], more: false });
      row.published = true;
      count += 1;
    }
    return count;
  }

  fanout(vaultId: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.vaultId !== vaultId || client.socket.readyState !== client.socket.OPEN) continue;
      if (client.socket.bufferedAmount > 1_000_000) continue;
      client.socket.send(data);
    }
  }
}

export function appliedToOps(ops: AppliedOp[]): ServerMessage {
  return { t: 'ops', ops, more: false };
}
