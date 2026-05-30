import { randomUUID } from 'node:crypto';
import type { SnapshotHistoryReason, SnapshotVersionMetadata, VersionVector } from '@obsidian-sync/shared';
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
  reason?: SnapshotHistoryReason;
  deviceId?: string | null;
  userId?: string | null;
}

export interface YjsSnapshotVersion extends SnapshotVersionMetadata {
  vaultId: string;
  snapshot: Uint8Array;
  stateVector: Uint8Array;
}

export interface YjsHistoryPage {
  versions: SnapshotVersionMetadata[];
  more: boolean;
}

export interface YjsRoomStore {
  getRoom(vaultId: string, fileId: string): Promise<PersistedYjsRoom | null>;
  saveRoom(room: PersistedYjsRoom): Promise<void>;
  appendUpdate(update: StoredYjsUpdate): Promise<void>;
  listUpdates(vaultId: string, fileId: string, roomEpoch: number, afterSeq?: number): Promise<StoredYjsUpdate[]>;
  saveSnapshot(snapshot: YjsSnapshot): Promise<void>;
  listSnapshotHistory(vaultId: string, fileId: string, limit: number, beforeVersionId?: string): Promise<YjsHistoryPage>;
  getSnapshotVersion(vaultId: string, fileId: string, versionId: string): Promise<YjsSnapshotVersion | null>;
  listSnapshotHistoryForGc(): Promise<Array<SnapshotVersionMetadata & { vaultId: string; isCurrent: boolean }>>;
  pruneSnapshotHistory(versionIds: string[]): Promise<number>;
  deleteUpdatesThrough(vaultId: string, fileId: string, roomEpoch: number, seq: number): Promise<void>;
  pruneSupersededYjsData?(): Promise<{ snapshots: number; updates: number }>;
}

export class InMemoryYjsRoomStore implements YjsRoomStore {
  readonly rooms = new Map<string, PersistedYjsRoom>();
  readonly updates = new Map<string, StoredYjsUpdate[]>();
  readonly snapshots = new Map<string, YjsSnapshot>();
  readonly history = new Map<string, YjsSnapshotVersion>();

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
    const cloned = cloneSnapshot(snapshot);
    this.snapshots.set(key, cloned);
    const room = await this.getRoom(snapshot.vaultId, snapshot.fileId);
    if (room && room.epoch === snapshot.roomEpoch) {
      await this.saveRoom({ ...room, snapshot: snapshot.snapshot, stateVector: snapshot.stateVector, compactedThroughSeq: snapshot.compactedThroughSeq });
    }
    const versionId = randomUUID();
    this.history.set(versionId, {
      versionId,
      vaultId: snapshot.vaultId,
      fileId: snapshot.fileId,
      roomEpoch: snapshot.roomEpoch,
      seq: snapshot.compactedThroughSeq,
      createdAt: snapshot.createdAt.getTime(),
      reason: snapshot.reason ?? 'compact',
      deviceId: snapshot.deviceId ?? undefined,
      userId: snapshot.userId ?? undefined,
      snapshot: cloned.snapshot,
      stateVector: cloned.stateVector,
    });
  }

  async listSnapshotHistory(vaultId: string, fileId: string, limit: number, beforeVersionId?: string): Promise<YjsHistoryPage> {
    const sorted = [...this.history.values()]
      .filter((v) => v.vaultId === vaultId && v.fileId === fileId)
      .sort(compareVersionsDesc);
    const before = beforeVersionId ? sorted.find((v) => v.versionId === beforeVersionId) : undefined;
    const filtered = before ? sorted.filter((v) => compareVersionsDesc(v, before) > 0) : sorted;
    const page = filtered.slice(0, limit + 1);
    return { versions: page.slice(0, limit).map(metadataOnly), more: page.length > limit };
  }

  async getSnapshotVersion(vaultId: string, fileId: string, versionId: string): Promise<YjsSnapshotVersion | null> {
    const version = this.history.get(versionId);
    return version && version.vaultId === vaultId && version.fileId === fileId ? cloneVersion(version) : null;
  }

  async listSnapshotHistoryForGc(): Promise<Array<SnapshotVersionMetadata & { vaultId: string; isCurrent: boolean }>> {
    return [...this.history.values()].map((version) => {
      const room = this.rooms.get(roomKey(version.vaultId, version.fileId));
      return { ...metadataOnly(version), vaultId: version.vaultId, isCurrent: Boolean(room && room.epoch === version.roomEpoch && room.compactedThroughSeq === version.seq) };
    });
  }

  async pruneSnapshotHistory(versionIds: string[]): Promise<number> {
    let deleted = 0;
    for (const versionId of versionIds) if (this.history.delete(versionId)) deleted += 1;
    return deleted;
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
    await this.db.query(`INSERT INTO yjs_snapshot_history(version_id,vault_id,file_id,room_epoch,seq,snapshot,state_vector,created_at,reason,device_id,user_id)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [snapshot.vaultId, snapshot.fileId, snapshot.roomEpoch, snapshot.compactedThroughSeq, Buffer.from(snapshot.snapshot), Buffer.from(snapshot.stateVector), snapshot.createdAt, snapshot.reason ?? 'compact', snapshot.deviceId ?? null, snapshot.userId ?? null]);
  }

  async listSnapshotHistory(vaultId: string, fileId: string, limit: number, beforeVersionId?: string): Promise<YjsHistoryPage> {
    const before = beforeVersionId
      ? (await this.db.query<{ created_at: Date; seq: string | number; version_id: string }>('SELECT created_at,seq,version_id FROM yjs_snapshot_history WHERE vault_id=$1 AND file_id=$2 AND version_id=$3', [vaultId, fileId, beforeVersionId])).rows[0]
      : null;
    const params: unknown[] = [vaultId, fileId, limit + 1];
    let where = 'vault_id=$1 AND file_id=$2';
    if (before) {
      params.push(before.created_at, before.seq, before.version_id);
      where += ' AND (created_at,seq,version_id) < ($4,$5,$6)';
    }
    const rows = (await this.db.query<HistoryRow>(`SELECT version_id,vault_id,file_id,room_epoch,seq,created_at,reason,device_id,user_id FROM yjs_snapshot_history WHERE ${where} ORDER BY created_at DESC, seq DESC, version_id DESC LIMIT $3`, params)).rows;
    return { versions: rows.slice(0, limit).map(historyRowToMetadata), more: rows.length > limit };
  }

  async getSnapshotVersion(vaultId: string, fileId: string, versionId: string): Promise<YjsSnapshotVersion | null> {
    const row = (await this.db.query<HistoryRow & { snapshot: Buffer; state_vector: Buffer }>('SELECT * FROM yjs_snapshot_history WHERE vault_id=$1 AND file_id=$2 AND version_id=$3', [vaultId, fileId, versionId])).rows[0];
    return row ? { ...historyRowToMetadata(row), vaultId: row.vault_id, snapshot: new Uint8Array(row.snapshot), stateVector: new Uint8Array(row.state_vector) } : null;
  }

  async listSnapshotHistoryForGc(): Promise<Array<SnapshotVersionMetadata & { vaultId: string; isCurrent: boolean }>> {
    const rows = (await this.db.query<HistoryRow & { is_current: boolean }>(`SELECT h.version_id,h.vault_id,h.file_id,h.room_epoch,h.seq,h.created_at,h.reason,h.device_id,h.user_id,
        EXISTS(SELECT 1 FROM yjs_rooms r WHERE r.vault_id=h.vault_id AND r.file_id=h.file_id AND r.room_epoch=h.room_epoch)
          AND EXISTS(SELECT 1 FROM yjs_snapshots s WHERE s.vault_id=h.vault_id AND s.file_id=h.file_id AND s.room_epoch=h.room_epoch AND s.compacted_through_seq=h.seq) AS is_current
      FROM yjs_snapshot_history h`)).rows;
    return rows.map((r) => ({ ...historyRowToMetadata(r), vaultId: r.vault_id, isCurrent: r.is_current }));
  }

  async pruneSnapshotHistory(versionIds: string[]): Promise<number> {
    if (versionIds.length === 0) return 0;
    const result = await this.db.query<{ count: string }>('WITH deleted AS (DELETE FROM yjs_snapshot_history WHERE version_id = ANY($1::uuid[]) RETURNING 1) SELECT count(*) FROM deleted', [versionIds]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async pruneSupersededYjsData(): Promise<{ snapshots: number; updates: number }> {
    const snapshots = await this.db.query<{ count: string }>(`WITH deleted AS (
      DELETE FROM yjs_snapshots s USING yjs_rooms r
      WHERE s.vault_id=r.vault_id AND s.file_id=r.file_id AND s.room_epoch < r.room_epoch
      RETURNING 1) SELECT count(*) FROM deleted`);
    const updates = await this.db.query<{ count: string }>(`WITH deleted AS (
      DELETE FROM yjs_updates u USING yjs_snapshots s
      WHERE u.vault_id=s.vault_id AND u.file_id=s.file_id AND u.room_epoch=s.room_epoch AND u.seq<=s.compacted_through_seq
      RETURNING 1) SELECT count(*) FROM deleted`);
    return { snapshots: Number(snapshots.rows[0]?.count ?? 0), updates: Number(updates.rows[0]?.count ?? 0) };
  }

  async deleteUpdatesThrough(vaultId: string, fileId: string, roomEpoch: number, seq: number): Promise<void> {
    await this.db.query('DELETE FROM yjs_updates WHERE vault_id=$1 AND file_id=$2 AND room_epoch=$3 AND seq<=$4', [vaultId, fileId, roomEpoch, seq]);
  }
}

type RoomRow = { file_id: string; vault_id: string; room_epoch: string | number; active: boolean; seeded: boolean; lease_owner: string | null; lease_until: Date | null; activation_base_vv: VersionVector; activation_base_hash: string | null; next_seq: string | number };
type UpdateRow = { vault_id: string; file_id: string; room_epoch: string | number; seq: string | number; update: Buffer; device_id: string; created_at: Date };
type SnapshotRow = { vault_id: string; file_id: string; room_epoch: string | number; snapshot: Buffer; state_vector: Buffer; compacted_through_seq: string | number; created_at: Date };
type HistoryRow = { version_id: string; vault_id: string; file_id: string; room_epoch: string | number; seq: string | number; created_at: Date; reason: SnapshotHistoryReason; device_id: string | null; user_id: string | null };

function roomKey(vaultId: string, fileId: string): string { return `${vaultId}:${fileId}`; }
function updateKey(vaultId: string, fileId: string, epoch: number): string { return `${vaultId}:${fileId}:${epoch}`; }

function cloneRoom(room: PersistedYjsRoom): PersistedYjsRoom {
  return { ...room, activationBaseVV: { ...room.activationBaseVV }, leaseUntil: room.leaseUntil ? new Date(room.leaseUntil) : null, snapshot: room.snapshot ? new Uint8Array(room.snapshot) : null, stateVector: room.stateVector ? new Uint8Array(room.stateVector) : null };
}
function cloneUpdate(update: StoredYjsUpdate): StoredYjsUpdate { return { ...update, update: new Uint8Array(update.update), createdAt: new Date(update.createdAt) }; }
function cloneSnapshot(snapshot: YjsSnapshot): YjsSnapshot { return { ...snapshot, snapshot: new Uint8Array(snapshot.snapshot), stateVector: new Uint8Array(snapshot.stateVector), createdAt: new Date(snapshot.createdAt) }; }
function metadataOnly(version: YjsSnapshotVersion): SnapshotVersionMetadata {
  return { versionId: version.versionId, fileId: version.fileId, roomEpoch: version.roomEpoch, seq: version.seq, createdAt: version.createdAt, reason: version.reason, deviceId: version.deviceId, userId: version.userId };
}
function cloneVersion(version: YjsSnapshotVersion): YjsSnapshotVersion { return { ...version, snapshot: new Uint8Array(version.snapshot), stateVector: new Uint8Array(version.stateVector) }; }
function compareVersionsDesc(a: Pick<YjsSnapshotVersion, 'createdAt' | 'seq' | 'versionId'>, b: Pick<YjsSnapshotVersion, 'createdAt' | 'seq' | 'versionId'>): number {
  return b.createdAt - a.createdAt || b.seq - a.seq || b.versionId.localeCompare(a.versionId);
}
function historyRowToMetadata(row: HistoryRow): SnapshotVersionMetadata {
  return { versionId: row.version_id, fileId: row.file_id, roomEpoch: Number(row.room_epoch), seq: Number(row.seq), createdAt: row.created_at.getTime(), reason: row.reason, deviceId: row.device_id ?? undefined, userId: row.user_id ?? undefined };
}
