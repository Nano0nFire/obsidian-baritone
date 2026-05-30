import type { VersionVector } from '@obsidian-sync/shared';
import type { PgDatabase, Queryable } from '../db/pool.js';

export interface PersistedYjsRoom {
  vaultId: string;
  fileId: string;
  epoch: number;
  active: boolean;
  seeded: boolean;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  activationBaseVV: VersionVector;
  activationBaseHash: string | null;
  nextSeq: number;
  snapshot: Uint8Array | null;
  stateVector: Uint8Array | null;
  compactedThroughSeq: number;
}

export interface StoredYjsUpdate {
  vaultId: string;
  fileId: string;
  roomEpoch: number;
  seq: number;
  deviceId: string;
  update: Uint8Array;
  createdAt: Date;
}

export interface YjsSnapshot {
  vaultId: string;
  fileId: string;
  roomEpoch: number;
  snapshot: Uint8Array;
  stateVector: Uint8Array;
  compactedThroughSeq: number;
  createdAt: Date;
}

export interface YjsRoomStore {
  getRoom(vaultId: string, fileId: string): Promise<PersistedYjsRoom | null>;
  saveRoom(room: PersistedYjsRoom): Promise<void>;
  appendUpdate(update: StoredYjsUpdate): Promise<void>;
  listUpdates(vaultId: string, fileId: string, roomEpoch: number, afterSeq?: number): Promise<StoredYjsUpdate[]>;
  saveSnapshot(snapshot: YjsSnapshot): Promise<void>;
  deleteUpdatesThrough(vaultId: string, fileId: string, roomEpoch: number, seq: number): Promise<void>;
}

export class InMemoryYjsRoomStore implements YjsRoomStore {
  readonly rooms = new Map<string, PersistedYjsRoom>();
  readonly updates = new Map<string, StoredYjsUpdate[]>();
  readonly snapshots = new Map<string, YjsSnapshot>();

  async getRoom(vaultId: string, fileId: string): Promise<PersistedYjsRoom | null> {
    const room = this.rooms.get(roomKey(vaultId, fileId));
    return room ? cloneRoom(room) : null;
  }

  async saveRoom(room: PersistedYjsRoom): Promise<void> {
    this.rooms.set(roomKey(room.vaultId, room.fileId), cloneRoom(room));
  }

  async appendUpdate(update: StoredYjsUpdate): Promise<void> {
    const key = updateKey(update.vaultId, update.fileId, update.roomEpoch);
    const list = this.updates.get(key) ?? [];
    list.push(cloneUpdate(update));
    list.sort((a, b) => a.seq - b.seq);
    this.updates.set(key, list);
  }

  async listUpdates(vaultId: string, fileId: string, roomEpoch: number, afterSeq = 0): Promise<StoredYjsUpdate[]> {
    return (this.updates.get(updateKey(vaultId, fileId, roomEpoch)) ?? [])
      .filter((u) => u.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .map(cloneUpdate);
  }

  async saveSnapshot(snapshot: YjsSnapshot): Promise<void> {
    const key = updateKey(snapshot.vaultId, snapshot.fileId, snapshot.roomEpoch);
    this.snapshots.set(key, cloneSnapshot(snapshot));
    const room = await this.getRoom(snapshot.vaultId, snapshot.fileId);
    if (room && room.epoch === snapshot.roomEpoch) {
      await this.saveRoom({ ...room, snapshot: snapshot.snapshot, stateVector: snapshot.stateVector, compactedThroughSeq: snapshot.compactedThroughSeq });
    }
  }

  async deleteUpdatesThrough(vaultId: string, fileId: string, roomEpoch: number, seq: number): Promise<void> {
    const key = updateKey(vaultId, fileId, roomEpoch);
    this.updates.set(key, (this.updates.get(key) ?? []).filter((u) => u.seq > seq).map(cloneUpdate));
  }
}

export class PgYjsRoomStore implements YjsRoomStore {
  constructor(private readonly db: PgDatabase | Queryable) {}

  async getRoom(vaultId: string, fileId: string): Promise<PersistedYjsRoom | null> {
    const row = (await this.db.query<RoomRow>('SELECT * FROM yjs_rooms WHERE vault_id=$1 AND file_id=$2', [vaultId, fileId])).rows[0];
    if (!row) return null;
    const snap = (await this.db.query<SnapshotRow>('SELECT * FROM yjs_snapshots WHERE vault_id=$1 AND file_id=$2 AND room_epoch=$3', [vaultId, fileId, row.room_epoch])).rows[0];
    return {
      vaultId: row.vault_id,
      fileId: row.file_id,
      epoch: Number(row.room_epoch),
      active: row.active,
      seeded: row.seeded,
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until,
      activationBaseVV: row.activation_base_vv,
      activationBaseHash: row.activation_base_hash,
      nextSeq: Number(row.next_seq),
      snapshot: snap ? new Uint8Array(snap.snapshot) : null,
      stateVector: snap ? new Uint8Array(snap.state_vector) : null,
      compactedThroughSeq: snap ? Number(snap.compacted_through_seq) : 0,
    };
  }

  async saveRoom(room: PersistedYjsRoom): Promise<void> {
    await this.db.query(`INSERT INTO yjs_rooms(file_id,vault_id,room_epoch,active,seeded,lease_owner,lease_until,activation_base_vv,activation_base_hash,next_seq,last_update_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      ON CONFLICT(file_id) DO UPDATE SET vault_id=EXCLUDED.vault_id,room_epoch=EXCLUDED.room_epoch,active=EXCLUDED.active,seeded=EXCLUDED.seeded,lease_owner=EXCLUDED.lease_owner,lease_until=EXCLUDED.lease_until,activation_base_vv=EXCLUDED.activation_base_vv,activation_base_hash=EXCLUDED.activation_base_hash,next_seq=EXCLUDED.next_seq,last_update_at=now()`,
      [room.fileId, room.vaultId, room.epoch, room.active, room.seeded, room.leaseOwner, room.leaseUntil, room.activationBaseVV, room.activationBaseHash, room.nextSeq]);
  }

  async appendUpdate(update: StoredYjsUpdate): Promise<void> {
    await this.db.query('INSERT INTO yjs_updates(vault_id,file_id,room_epoch,seq,update,device_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [update.vaultId, update.fileId, update.roomEpoch, update.seq, Buffer.from(update.update), update.deviceId, update.createdAt]);
  }

  async listUpdates(vaultId: string, fileId: string, roomEpoch: number, afterSeq = 0): Promise<StoredYjsUpdate[]> {
    const rows = (await this.db.query<UpdateRow>('SELECT * FROM yjs_updates WHERE vault_id=$1 AND file_id=$2 AND room_epoch=$3 AND seq>$4 ORDER BY seq ASC', [vaultId, fileId, roomEpoch, afterSeq])).rows;
    return rows.map((r) => ({ vaultId: r.vault_id, fileId: r.file_id, roomEpoch: Number(r.room_epoch), seq: Number(r.seq), deviceId: r.device_id, update: new Uint8Array(r.update), createdAt: r.created_at }));
  }

  async saveSnapshot(snapshot: YjsSnapshot): Promise<void> {
    await this.db.query(`INSERT INTO yjs_snapshots(vault_id,file_id,room_epoch,snapshot,state_vector,compacted_through_seq,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(file_id,room_epoch) DO UPDATE SET snapshot=EXCLUDED.snapshot,state_vector=EXCLUDED.state_vector,compacted_through_seq=EXCLUDED.compacted_through_seq,created_at=EXCLUDED.created_at`,
      [snapshot.vaultId, snapshot.fileId, snapshot.roomEpoch, Buffer.from(snapshot.snapshot), Buffer.from(snapshot.stateVector), snapshot.compactedThroughSeq, snapshot.createdAt]);
  }

  async deleteUpdatesThrough(vaultId: string, fileId: string, roomEpoch: number, seq: number): Promise<void> {
    await this.db.query('DELETE FROM yjs_updates WHERE vault_id=$1 AND file_id=$2 AND room_epoch=$3 AND seq<=$4', [vaultId, fileId, roomEpoch, seq]);
  }
}

type RoomRow = { file_id: string; vault_id: string; room_epoch: string | number; active: boolean; seeded: boolean; lease_owner: string | null; lease_until: Date | null; activation_base_vv: VersionVector; activation_base_hash: string | null; next_seq: string | number };
type UpdateRow = { vault_id: string; file_id: string; room_epoch: string | number; seq: string | number; update: Buffer; device_id: string; created_at: Date };
type SnapshotRow = { vault_id: string; file_id: string; room_epoch: string | number; snapshot: Buffer; state_vector: Buffer; compacted_through_seq: string | number; created_at: Date };

function roomKey(vaultId: string, fileId: string): string { return `${vaultId}:${fileId}`; }
function updateKey(vaultId: string, fileId: string, epoch: number): string { return `${vaultId}:${fileId}:${epoch}`; }

function cloneRoom(room: PersistedYjsRoom): PersistedYjsRoom {
  return { ...room, activationBaseVV: { ...room.activationBaseVV }, leaseUntil: room.leaseUntil ? new Date(room.leaseUntil) : null, snapshot: room.snapshot ? new Uint8Array(room.snapshot) : null, stateVector: room.stateVector ? new Uint8Array(room.stateVector) : null };
}
function cloneUpdate(update: StoredYjsUpdate): StoredYjsUpdate { return { ...update, update: new Uint8Array(update.update), createdAt: new Date(update.createdAt) }; }
function cloneSnapshot(snapshot: YjsSnapshot): YjsSnapshot { return { ...snapshot, snapshot: new Uint8Array(snapshot.snapshot), stateVector: new Uint8Array(snapshot.stateVector), createdAt: new Date(snapshot.createdAt) }; }
