import { ErrorCode, SyncError, type AppliedOp, type ConflictRecord, type ConflictStatus, type ContentEncryptionEncoding, type FileOp, type FileType, type PathClock, type VersionVector } from '@obsidian-sync/shared';
import { type BlobRecord, type BlobRef, type ManifestCursor, type OpApplyResult, type OpDataStore, type Role, type StoredDevice, type StoredFile, type StoredOp, toManifestEntry } from '../engine/store.js';
import { PgDatabase, type Queryable } from './pool.js';

export class PgOpDataStore implements OpDataStore {
  constructor(private readonly db: PgDatabase | Queryable) {}

  async withTransaction<T>(fn: (tx: OpDataStore) => Promise<T>): Promise<T> {
    if (this.db instanceof PgDatabase) return this.db.withTx((tx) => fn(new PgOpDataStore(tx)));
    return fn(this);
  }

  async getDevice(deviceId: string): Promise<StoredDevice | null> {
    const r = (await this.db.query<DeviceRow>('SELECT device_id,user_id,vault_id,last_device_seq,last_seq,revoked,last_seen FROM devices WHERE device_id=$1', [deviceId])).rows[0];
    return r ? { deviceId: r.device_id, userId: r.user_id, vaultId: r.vault_id, lastDeviceSeq: Number(r.last_device_seq), lastSeq: Number(r.last_seq), revoked: r.revoked, lastSeen: r.last_seen ?? undefined } : null;
  }
  async saveDevice(d: StoredDevice): Promise<void> {
    await this.db.query('UPDATE devices SET last_device_seq=$2,last_seq=$3,last_seen=now(),revoked=$4 WHERE device_id=$1', [d.deviceId, d.lastDeviceSeq, d.lastSeq, d.revoked]);
  }
  async getRole(vaultId: string, userId: string): Promise<Role | null> {
    return (await this.db.query<{ role: Role }>('SELECT role FROM vault_members WHERE vault_id=$1 AND user_id=$2', [vaultId, userId])).rows[0]?.role ?? null;
  }
  async getOpById(opId: string): Promise<StoredOp | null> { return mapOp((await this.db.query<OpRow>('SELECT * FROM file_ops WHERE op_id=$1', [opId])).rows[0]); }
  async getOpByDeviceSeq(deviceId: string, deviceSeq: number): Promise<StoredOp | null> { return mapOp((await this.db.query<OpRow>('SELECT * FROM file_ops WHERE device_id=$1 AND device_seq=$2', [deviceId, deviceSeq])).rows[0]); }
  async getFile(vaultId: string, fileId: string): Promise<StoredFile | null> { return mapFile((await this.db.query<FileRow>('SELECT * FROM files WHERE vault_id=$1 AND file_id=$2', [vaultId, fileId])).rows[0]); }
  async saveFile(f: StoredFile): Promise<void> {
    await this.db.query(`INSERT INTO files(file_id,vault_id,type,path,path_normalized,path_clock,content_vv,content_hash,size,blob_ref,content_encoding,delete_vv,deleted,deleted_at,epoch,conflict_id,active_lease_until,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
      ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,path_normalized=EXCLUDED.path_normalized,path_clock=EXCLUDED.path_clock,content_vv=EXCLUDED.content_vv,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,blob_ref=EXCLUDED.blob_ref,content_encoding=EXCLUDED.content_encoding,delete_vv=EXCLUDED.delete_vv,deleted=EXCLUDED.deleted,deleted_at=EXCLUDED.deleted_at,epoch=EXCLUDED.epoch,conflict_id=EXCLUDED.conflict_id,active_lease_until=EXCLUDED.active_lease_until,updated_at=now()`,
      [f.fileId, f.vaultId, f.type, f.path, f.pathNormalized, f.pathClock, f.contentVV, f.contentHash, f.size, f.blobRef, f.contentEncoding, f.deleteVV, f.deleted, f.deletedAt, f.epoch, f.conflictId, f.activeUntil]);
  }
  async findLiveFileByPath(vaultId: string, pathNormalized: string): Promise<StoredFile | null> { return mapFile((await this.db.query<FileRow>('SELECT * FROM files WHERE vault_id=$1 AND path_normalized=$2 AND deleted=false', [vaultId, pathNormalized])).rows[0]); }
  async nextVaultSeq(vaultId: string): Promise<number> { return Number((await this.db.query<{ seq: string }>('UPDATE vaults SET next_seq=next_seq+1 WHERE vault_id=$1 RETURNING next_seq-1 AS seq', [vaultId])).rows[0]!.seq); }
  async appendOp(op: StoredOp): Promise<void> { await this.db.query('INSERT INTO file_ops(vault_id,seq,op_id,device_id,device_seq,file_id,kind,payload,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [op.vaultId, op.seq, op.opId, op.deviceId, op.deviceSeq, op.fileId, op.kind, op.payload, op.result]); }
  async appendOutbox(vaultId: string, vaultSeq: number, payload: AppliedOp): Promise<void> { await this.db.query('INSERT INTO outbox(vault_id,vault_seq,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [vaultId, vaultSeq, payload]); }
  async listOps(vaultId: string, sinceSeq: number, limit: number): Promise<AppliedOp[]> { const rows = (await this.db.query<OpRow>('SELECT * FROM file_ops WHERE vault_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3', [vaultId, sinceSeq, limit])).rows; return rows.map((r) => ({ vaultSeq: Number(r.seq), op: r.payload, resultingClocks: r.result.type === 'ack' ? r.result.resultingClocks : { epoch: 0 } })); }
  async currentSeq(vaultId: string): Promise<number> { const r = (await this.db.query<{ seq: string }>('SELECT COALESCE(MAX(seq),0) AS seq FROM file_ops WHERE vault_id=$1', [vaultId])).rows[0]; return Number(r?.seq ?? 0); }
  async getBlob(hash: string): Promise<BlobRecord | null> { const r = (await this.db.query<BlobRow>('SELECT * FROM blobs WHERE hash=$1', [hash])).rows[0]; return r ? { hash: r.hash, size: Number(r.size), state: r.state, objectKey: r.object_key, createdAt: r.created_at, verifiedAt: r.verified_at, unreferencedAt: r.unreferenced_at, deletedAt: r.deleted_at } : null; }
  async saveBlob(b: BlobRecord): Promise<void> { await this.db.query('INSERT INTO blobs(hash,size,state,object_key,created_at,verified_at,unreferenced_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(hash) DO UPDATE SET size=EXCLUDED.size,state=EXCLUDED.state,object_key=EXCLUDED.object_key,verified_at=EXCLUDED.verified_at,unreferenced_at=EXCLUDED.unreferenced_at,deleted_at=EXCLUDED.deleted_at', [b.hash, b.size, b.state, b.objectKey, b.createdAt, b.verifiedAt, b.unreferencedAt, b.deletedAt]); }
  async addBlobRef(r: BlobRef): Promise<void> { await this.db.query('INSERT INTO blob_refs(hash,ref_type,ref_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [r.hash, r.refType, r.refId]); }
  async removeBlobRef(hash: string, refType: BlobRef['refType'], refId: string): Promise<void> { await this.db.query('DELETE FROM blob_refs WHERE hash=$1 AND ref_type=$2 AND ref_id=$3', [hash, refType, refId]); }
  async listBlobRefs(hash: string): Promise<BlobRef[]> { return (await this.db.query<{ hash: string; ref_type: BlobRef['refType']; ref_id: string }>('SELECT hash,ref_type,ref_id FROM blob_refs WHERE hash=$1', [hash])).rows.map((r) => ({ hash: r.hash, refType: r.ref_type, refId: r.ref_id })); }
  async createConflict(input: Omit<ConflictRecord, 'conflictId' | 'status'>): Promise<ConflictRecord> { const r = (await this.db.query<ConflictRow>("INSERT INTO conflicts(vault_id,file_id,kind,base_hash,ours_hash,theirs_hash,ours_vv,theirs_vv) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(file_id,kind,COALESCE(ours_hash, ''),COALESCE(theirs_hash, '')) WHERE status <> 'resolved' DO UPDATE SET status=conflicts.status RETURNING *", [input.vaultId, input.fileId, input.kind, input.baseHash, input.oursHash, input.theirsHash, input.oursVV, input.theirsVV])).rows[0]!; return mapConflict(r); }
  async getConflict(conflictId: string): Promise<ConflictRecord | null> { const r = (await this.db.query<ConflictRow>('SELECT * FROM conflicts WHERE conflict_id=$1', [conflictId])).rows[0]; return r ? mapConflict(r) : null; }
  async saveConflict(c: ConflictRecord): Promise<void> {
    const result = await this.db.query('UPDATE conflicts SET status=$2,claimed_by=$3,resolved_by=$4,resolved_hash=$5,resolved_vv=$6,resolved_at=CASE WHEN $2=$7 THEN now() ELSE resolved_at END WHERE conflict_id=$1 AND (status <> $7 OR $2 = $7)', [c.conflictId, c.status, c.claimedBy ?? null, (c as { resolvedBy?: string }).resolvedBy ?? null, (c as { resolvedHash?: string }).resolvedHash ?? null, (c as { resolvedVV?: VersionVector }).resolvedVV ?? null, 'resolved']);
    if ((result.rowCount ?? 0) === 0 && c.status !== 'resolved') throw new SyncError(ErrorCode.CONFLICT_ALREADY_RESOLVED, 'Conflict already resolved');
  }
  async compareAndSetConflict(c: ConflictRecord, expected: { status: ConflictStatus; claimedBy?: string | null }): Promise<boolean> {
    const result = await this.db.query(
      'UPDATE conflicts SET status=$2,claimed_by=$3,resolved_by=$4,resolved_hash=$5,resolved_vv=$6,resolved_at=CASE WHEN $2=$7 THEN now() ELSE resolved_at END WHERE conflict_id=$1 AND status=$8 AND claimed_by IS NOT DISTINCT FROM $9',
      [c.conflictId, c.status, c.claimedBy ?? null, (c as { resolvedBy?: string }).resolvedBy ?? null, (c as { resolvedHash?: string }).resolvedHash ?? null, (c as { resolvedVV?: VersionVector }).resolvedVV ?? null, 'resolved', expected.status, expected.claimedBy ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }
  async listManifest(vaultId: string, cursor: ManifestCursor | null, limit: number) { const params: unknown[] = [vaultId, limit]; const cond = cursor ? 'AND (path_normalized,file_id) > ($3,$4)' : ''; if (cursor) params.push(cursor.pathNormalized, cursor.fileId); const rows = (await this.db.query<FileRow>(`SELECT * FROM files WHERE vault_id=$1 AND deleted=false ${cond} ORDER BY path_normalized,file_id LIMIT $2`, params)).rows; const items = rows.map((r) => toManifestEntry(mapFile(r)!)); const last = rows.at(-1); return { items, nextCursor: rows.length === limit && last ? { pathNormalized: last.path_normalized, fileId: last.file_id } : null }; }
  async listTrash(vaultId: string): Promise<StoredFile[]> { return (await this.db.query<FileRow>('SELECT * FROM files WHERE vault_id=$1 AND deleted=true ORDER BY deleted_at ASC', [vaultId])).rows.map((r) => mapFile(r)!); }
  async hasContentForVault(vaultId: string, hash: string): Promise<boolean> {
    return Boolean((await this.db.query<{ exists: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM files WHERE vault_id=$1 AND content_hash=$2
        UNION ALL
        SELECT 1 FROM conflicts WHERE vault_id=$1 AND $2 IN (base_hash, ours_hash, theirs_hash, resolved_hash)
        UNION ALL
        SELECT 1 FROM file_ops WHERE vault_id=$1 AND ((payload->>'contentHash') = $2 OR (payload->>'blobRef') = $2)
      ) AS exists
    `, [vaultId, hash])).rows[0]?.exists);
  }
  async getContent(hash: string): Promise<Uint8Array | null> { const r = (await this.db.query<{ text: Buffer }>('SELECT text FROM note_content WHERE content_hash=$1', [hash])).rows[0]; return r ? new Uint8Array(r.text) : null; }
  async putContent(hash: string, bytes: Uint8Array): Promise<void> { await this.db.query('INSERT INTO note_content(content_hash,text,size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [hash, Buffer.from(bytes), bytes.byteLength]); }
}

type DeviceRow = { device_id: string; user_id: string; vault_id: string; last_device_seq: string; last_seq: string; revoked: boolean; last_seen: Date | null };
type OpRow = { vault_id: string; seq: string; op_id: string; device_id: string; device_seq: string; file_id: string; kind: string; payload: FileOp; result: OpApplyResult; created_at: Date };
type FileRow = { file_id: string; vault_id: string; type: FileType; path: string; path_normalized: string; path_clock: PathClock; content_vv: VersionVector; content_hash: string | null; size: string | null; blob_ref: string | null; content_encoding: ContentEncryptionEncoding | null; delete_vv: VersionVector | null; deleted: boolean; deleted_at: Date | null; epoch: number; conflict_id: string | null; active_lease_until: Date | null; updated_at: Date };
type BlobRow = { hash: string; size: string; state: BlobRecord['state']; object_key: string; created_at: Date; verified_at: Date | null; unreferenced_at: Date | null; deleted_at: Date | null };
type ConflictRow = { conflict_id: string; vault_id: string; file_id: string; kind: ConflictRecord['kind']; base_hash: string | null; ours_hash: string | null; theirs_hash: string | null; ours_vv: VersionVector | null; theirs_vv: VersionVector | null; status: ConflictRecord['status']; claimed_by: string | null };

function mapOp(r?: OpRow): StoredOp | null { return r ? { vaultId: r.vault_id, seq: Number(r.seq), opId: r.op_id, deviceId: r.device_id, deviceSeq: Number(r.device_seq), fileId: r.file_id, kind: r.kind, payload: r.payload, result: r.result, createdAt: r.created_at } : null; }
function mapFile(r?: FileRow): StoredFile | null { return r ? { fileId: r.file_id, vaultId: r.vault_id, type: r.type, path: r.path, pathNormalized: r.path_normalized, pathClock: r.path_clock, contentVV: r.content_vv, contentHash: r.content_hash, size: r.size === null ? null : Number(r.size), blobRef: r.blob_ref, contentEncoding: r.content_encoding, deleteVV: r.delete_vv, deleted: r.deleted, deletedAt: r.deleted_at, epoch: r.epoch, conflictId: r.conflict_id, activeUntil: r.active_lease_until, updatedAt: r.updated_at } : null; }
function mapConflict(r: ConflictRow): ConflictRecord { return { conflictId: r.conflict_id, vaultId: r.vault_id, fileId: r.file_id, kind: r.kind, baseHash: r.base_hash, oursHash: r.ours_hash, theirsHash: r.theirs_hash, oursVV: r.ours_vv, theirsVV: r.theirs_vv, status: r.status, claimedBy: r.claimed_by ?? undefined }; }
