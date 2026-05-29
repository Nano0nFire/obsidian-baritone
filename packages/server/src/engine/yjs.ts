import * as Y from 'yjs';
import { ErrorCode, SyncError, bump, contentHashText } from '@obsidian-sync/shared';
import type { OpDataStore } from './store.js';

export interface RoomState {
  fileId: string;
  vaultId: string;
  active: boolean;
  seeded: boolean;
  leaseOwner?: string;
  leaseUntil?: Date;
  updates: Uint8Array[];
  snapshot?: Uint8Array;
  stateVector?: Uint8Array;
}

export interface YjsRoomStore {
  getRoom(fileId: string): Promise<RoomState | null>;
  saveRoom(room: RoomState): Promise<void>;
}

export class InMemoryYjsRoomStore implements YjsRoomStore {
  readonly rooms = new Map<string, RoomState>();
  async getRoom(fileId: string): Promise<RoomState | null> { const r = this.rooms.get(fileId); return r ? { ...r, updates: r.updates.map((u) => new Uint8Array(u)) } : null; }
  async saveRoom(room: RoomState): Promise<void> { this.rooms.set(room.fileId, { ...room, updates: room.updates.map((u) => new Uint8Array(u)) }); }
}

export class YjsLayerService {
  constructor(private readonly data: OpDataStore, private readonly rooms: YjsRoomStore, private readonly leaseMs = 60_000) {}

  async promote(vaultId: string, fileId: string, deviceId: string, userId?: string): Promise<RoomState> {
    return this.data.withTransaction(async (tx) => {
      await requireEditor(tx, vaultId, deviceId, userId);
      const file = await tx.getFile(vaultId, fileId);
      if (!file || file.deleted) throw new SyncError(ErrorCode.NOT_FOUND, 'File not found');
      const now = new Date();
      let room = await this.rooms.getRoom(fileId);
      if (room?.active && room.leaseOwner !== deviceId && room.leaseUntil && room.leaseUntil > now) throw new SyncError(ErrorCode.FILE_ACTIVE, 'Yjs promotion lease already held');
      if (!room) room = { fileId, vaultId, active: false, seeded: false, updates: [] };
      const doc = new Y.Doc();
      if (!room.seeded) {
        const text = doc.getText('obsidian');
        const bytes = file.contentHash ? await tx.getContent(file.contentHash) : null;
        if (bytes) text.insert(0, new TextDecoder().decode(bytes));
        room.updates.push(Y.encodeStateAsUpdate(doc));
        room.seeded = true;
      }
      for (const update of room.updates) Y.applyUpdate(doc, update);
      room.snapshot = Y.encodeStateAsUpdate(doc);
      room.stateVector = Y.encodeStateVector(doc);
      room.active = true;
      room.leaseOwner = deviceId;
      room.leaseUntil = new Date(now.getTime() + this.leaseMs);
      await this.rooms.saveRoom(room);
      await tx.saveFile({ ...file, activeUntil: room.leaseUntil });
      return room;
    });
  }

  async persistUpdate(vaultId: string, fileId: string, update: Uint8Array): Promise<void> {
    const room = await this.rooms.getRoom(fileId);
    if (!room || room.vaultId !== vaultId || !room.active) throw new SyncError(ErrorCode.FILE_ACTIVE, 'Room is not active');
    room.updates.push(new Uint8Array(update));
    await this.rooms.saveRoom(room);
  }

  async demote(vaultId: string, fileId: string, deviceId: string, userId?: string): Promise<{ hash: string; vv: Record<string, number> }> {
    return this.data.withTransaction(async (tx) => {
      await requireEditor(tx, vaultId, deviceId, userId);
      const file = await tx.getFile(vaultId, fileId);
      const room = await this.rooms.getRoom(fileId);
      if (!file || !room) throw new SyncError(ErrorCode.NOT_FOUND, 'Room not found');
      if (room.leaseOwner !== deviceId) throw new SyncError(ErrorCode.FORBIDDEN, 'Only lease owner can demote');
      const doc = new Y.Doc();
      for (const update of room.updates) Y.applyUpdate(doc, update);
      const text = doc.getText('obsidian').toString();
      const hash = await contentHashText(text);
      await tx.putContent(hash, new TextEncoder().encode(text));
      const vv = bump(file.contentVV, `collab:${fileId}`);
      await tx.saveFile({ ...file, contentHash: hash, contentVV: vv, activeUntil: null, updatedAt: new Date() });
      room.active = false;
      room.leaseOwner = undefined;
      room.leaseUntil = undefined;
      room.snapshot = Y.encodeStateAsUpdate(doc);
      room.stateVector = Y.encodeStateVector(doc);
      await this.rooms.saveRoom(room);
      return { hash, vv };
    });
  }
}

async function requireEditor(tx: OpDataStore, vaultId: string, deviceId: string, userId?: string): Promise<void> {
  const device = await tx.getDevice(deviceId);
  if (!device || device.vaultId !== vaultId || device.revoked) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Invalid device');
  const role = await tx.getRole(vaultId, userId ?? device.userId);
  if (role !== 'owner' && role !== 'editor') throw new SyncError(ErrorCode.FORBIDDEN, 'Write permission required');
}

// Extension point: attach a Yjs websocket relay here using persistUpdate(), promote(), and demote().
