import { randomUUID } from 'node:crypto';
import type { AppliedOp, ConflictRecord, ContentEncryptionEncoding, FileOp, FileType, ManifestEntry, ResultingClocks } from '@obsidian-sync/shared';
import { caseFoldPath, type PathClock, type VersionVector } from '@obsidian-sync/shared';

export type Role = 'owner' | 'editor' | 'viewer';
export type BlobState = 'pending' | 'uploaded' | 'verified' | 'unreferenced' | 'deleted';

export interface StoredDevice {
  deviceId: string;
  userId: string;
  vaultId: string;
  lastDeviceSeq: number;
  lastSeq: number;
  revoked: boolean;
  lastSeen?: Date;
}

export interface StoredFile {
  fileId: string;
  vaultId: string;
  type: FileType;
  path: string;
  pathNormalized: string;
  pathClock: PathClock;
  contentVV: VersionVector;
  contentHash: string | null;
  size: number | null;
  blobRef: string | null;
  contentEncoding: ContentEncryptionEncoding | null;
  deleteVV: VersionVector | null;
  deleted: boolean;
  deletedAt: Date | null;
  epoch: number;
  conflictId: string | null;
  activeUntil: Date | null;
  updatedAt: Date;
}

export interface StoredOp {
  vaultId: string;
  seq: number;
  opId: string;
  deviceId: string;
  deviceSeq: number;
  fileId: string;
  kind: string;
  payload: FileOp;
  result: OpApplyResult;
  createdAt: Date;
}

export interface BlobRecord {
  hash: string;
  size: number;
  state: BlobState;
  objectKey: string;
  createdAt: Date;
  verifiedAt: Date | null;
  unreferencedAt: Date | null;
  deletedAt: Date | null;
}

export interface BlobRef {
  hash: string;
  refType: 'file_live' | 'file_version' | 'conflict_base' | 'conflict_side' | 'yjs_snapshot' | 'trash';
  refId: string;
}

export interface OpAckResult {
  type: 'ack';
  opId: string;
  vaultSeq: number;
  resultingClocks: ResultingClocks;
  conflictId?: string;
}

export interface OpRejectResult {
  type: 'reject';
  opId?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type OpApplyResult = OpAckResult | OpRejectResult;

export interface OpDataStore {
  withTransaction<T>(fn: (tx: OpDataStore) => Promise<T>): Promise<T>;
  getDevice(deviceId: string): Promise<StoredDevice | null>;
  saveDevice(device: StoredDevice): Promise<void>;
  getRole(vaultId: string, userId: string): Promise<Role | null>;
  getOpById(opId: string): Promise<StoredOp | null>;
  getOpByDeviceSeq(deviceId: string, deviceSeq: number): Promise<StoredOp | null>;
  getFile(vaultId: string, fileId: string): Promise<StoredFile | null>;
  saveFile(file: StoredFile): Promise<void>;
  findLiveFileByPath(vaultId: string, pathNormalized: string): Promise<StoredFile | null>;
  nextVaultSeq(vaultId: string): Promise<number>;
  appendOp(op: StoredOp): Promise<void>;
  appendOutbox(vaultId: string, vaultSeq: number, payload: AppliedOp): Promise<void>;
  listOps(vaultId: string, sinceSeq: number, limit: number): Promise<AppliedOp[]>;
  currentSeq(vaultId: string): Promise<number>;
  getBlob(hash: string): Promise<BlobRecord | null>;
  saveBlob(blob: BlobRecord): Promise<void>;
  addBlobRef(ref: BlobRef): Promise<void>;
  removeBlobRef(hash: string, refType: BlobRef['refType'], refId: string): Promise<void>;
  listBlobRefs(hash: string): Promise<BlobRef[]>;
  createConflict(input: Omit<ConflictRecord, 'conflictId' | 'status'>): Promise<ConflictRecord>;
  getConflict(conflictId: string): Promise<ConflictRecord | null>;
  saveConflict(conflict: ConflictRecord): Promise<void>;
  listManifest(vaultId: string, cursor: ManifestCursor | null, limit: number): Promise<{ items: ManifestEntry[]; nextCursor: ManifestCursor | null }>;
  listTrash(vaultId: string, now: Date): Promise<StoredFile[]>;
  getContent(hash: string): Promise<Uint8Array | null>;
  putContent(hash: string, bytes: Uint8Array): Promise<void>;
}

export interface ManifestCursor { pathNormalized: string; fileId: string }

export class InMemoryDataStore implements OpDataStore {
  readonly devices = new Map<string, StoredDevice>();
  readonly roles = new Map<string, Role>();
  readonly files = new Map<string, StoredFile>();
  readonly opsById = new Map<string, StoredOp>();
  readonly opsByDeviceSeq = new Map<string, StoredOp>();
  readonly opsByVault = new Map<string, StoredOp[]>();
  readonly blobs = new Map<string, BlobRecord>();
  readonly blobRefs = new Map<string, BlobRef>();
  readonly conflicts = new Map<string, ConflictRecord>();
  readonly content = new Map<string, Uint8Array>();
  readonly outbox: Array<{ vaultId: string; vaultSeq: number; payload: AppliedOp; published: boolean }> = [];
  private seqs = new Map<string, number>();

  async withTransaction<T>(fn: (tx: OpDataStore) => Promise<T>): Promise<T> {
    return fn(this);
  }

  roleKey(vaultId: string, userId: string): string { return `${vaultId}:${userId}`; }
  fileKey(vaultId: string, fileId: string): string { return `${vaultId}:${fileId}`; }

  async getDevice(deviceId: string): Promise<StoredDevice | null> { return clone(this.devices.get(deviceId) ?? null); }
  async saveDevice(device: StoredDevice): Promise<void> { this.devices.set(device.deviceId, clone(device)); }
  async getRole(vaultId: string, userId: string): Promise<Role | null> { return this.roles.get(this.roleKey(vaultId, userId)) ?? null; }
  async getOpById(opId: string): Promise<StoredOp | null> { return clone(this.opsById.get(opId) ?? null); }
  async getOpByDeviceSeq(deviceId: string, deviceSeq: number): Promise<StoredOp | null> { return clone(this.opsByDeviceSeq.get(`${deviceId}:${deviceSeq}`) ?? null); }
  async getFile(vaultId: string, fileId: string): Promise<StoredFile | null> { return clone(this.files.get(this.fileKey(vaultId, fileId)) ?? null); }
  async saveFile(file: StoredFile): Promise<void> { this.files.set(this.fileKey(file.vaultId, file.fileId), clone(file)); }
  async findLiveFileByPath(vaultId: string, pathNormalized: string): Promise<StoredFile | null> {
    for (const file of this.files.values()) if (file.vaultId === vaultId && !file.deleted && file.pathNormalized === pathNormalized) return clone(file);
    return null;
  }
  async nextVaultSeq(vaultId: string): Promise<number> {
    const next = this.seqs.get(vaultId) ?? 1;
    this.seqs.set(vaultId, next + 1);
    return next;
  }
  async appendOp(op: StoredOp): Promise<void> {
    const copy = clone(op);
    this.opsById.set(op.opId, copy);
    this.opsByDeviceSeq.set(`${op.deviceId}:${op.deviceSeq}`, copy);
    const list = this.opsByVault.get(op.vaultId) ?? [];
    list.push(copy);
    list.sort((a, b) => a.seq - b.seq);
    this.opsByVault.set(op.vaultId, list);
  }
  async appendOutbox(vaultId: string, vaultSeq: number, payload: AppliedOp): Promise<void> { this.outbox.push({ vaultId, vaultSeq, payload: clone(payload), published: false }); }
  async listOps(vaultId: string, sinceSeq: number, limit: number): Promise<AppliedOp[]> {
    return (this.opsByVault.get(vaultId) ?? []).filter((op) => op.seq > sinceSeq).slice(0, limit).map((op) => ({ vaultSeq: op.seq, op: clone(op.payload), resultingClocks: (op.result.type === 'ack' ? op.result.resultingClocks : { epoch: 0 }) }));
  }
  async currentSeq(vaultId: string): Promise<number> { return (this.seqs.get(vaultId) ?? 1) - 1; }
  async getBlob(hash: string): Promise<BlobRecord | null> { return clone(this.blobs.get(hash) ?? null); }
  async saveBlob(blob: BlobRecord): Promise<void> { this.blobs.set(blob.hash, clone(blob)); }
  async addBlobRef(ref: BlobRef): Promise<void> { this.blobRefs.set(`${ref.hash}:${ref.refType}:${ref.refId}`, clone(ref)); }
  async removeBlobRef(hash: string, refType: BlobRef['refType'], refId: string): Promise<void> { this.blobRefs.delete(`${hash}:${refType}:${refId}`); }
  async listBlobRefs(hash: string): Promise<BlobRef[]> { return [...this.blobRefs.values()].filter((r) => r.hash === hash).map(clone); }
  async createConflict(input: Omit<ConflictRecord, 'conflictId' | 'status'>): Promise<ConflictRecord> {
    for (const existing of this.conflicts.values()) {
      if (existing.fileId === input.fileId && existing.kind === input.kind && existing.oursHash === input.oursHash && existing.theirsHash === input.theirsHash && existing.status !== 'resolved') return clone(existing);
    }
    const conflict: ConflictRecord = { ...clone(input), conflictId: randomUUID(), status: 'open' };
    this.conflicts.set(conflict.conflictId, conflict);
    return clone(conflict);
  }
  async getConflict(conflictId: string): Promise<ConflictRecord | null> { return clone(this.conflicts.get(conflictId) ?? null); }
  async saveConflict(conflict: ConflictRecord): Promise<void> { this.conflicts.set(conflict.conflictId, clone(conflict)); }
  async listManifest(vaultId: string, cursor: ManifestCursor | null, limit: number): Promise<{ items: ManifestEntry[]; nextCursor: ManifestCursor | null }> {
    const files = [...this.files.values()].filter((f) => f.vaultId === vaultId && !f.deleted).sort((a, b) => a.pathNormalized.localeCompare(b.pathNormalized) || a.fileId.localeCompare(b.fileId));
    const filtered = cursor ? files.filter((f) => f.pathNormalized > cursor.pathNormalized || (f.pathNormalized === cursor.pathNormalized && f.fileId > cursor.fileId)) : files;
    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(toManifestEntry), nextCursor: filtered.length > limit && last ? { pathNormalized: last.pathNormalized, fileId: last.fileId } : null };
  }
  async listTrash(vaultId: string): Promise<StoredFile[]> { return [...this.files.values()].filter((f) => f.vaultId === vaultId && f.deleted).map(clone); }
  async getContent(hash: string): Promise<Uint8Array | null> { const bytes = this.content.get(hash); return bytes ? new Uint8Array(bytes) : null; }
  async putContent(hash: string, bytes: Uint8Array): Promise<void> { this.content.set(hash, new Uint8Array(bytes)); }
}

export function toManifestEntry(file: StoredFile): ManifestEntry {
  return { fileId: file.fileId, type: file.type, path: file.path, contentHash: file.contentHash, size: file.size, blobRef: file.blobRef, contentEncoding: file.contentEncoding, contentVV: file.contentVV, pathClock: file.pathClock, epoch: file.epoch, deleted: file.deleted };
}

export function newStoredFile(op: FileOp, path: string, pathClock: PathClock): StoredFile {
  return {
    fileId: op.fileId,
    vaultId: op.vaultId,
    type: op.type,
    path,
    pathNormalized: caseFoldPath(path),
    pathClock,
    contentVV: op.newContentVV ?? {},
    contentHash: op.contentHash ?? op.blobRef ?? null,
    size: op.size ?? null,
    blobRef: op.blobRef ?? null,
    contentEncoding: op.contentEncoding ?? null,
    deleteVV: null,
    deleted: false,
    deletedAt: null,
    epoch: 0,
    conflictId: null,
    activeUntil: null,
    updatedAt: new Date(),
  };
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return structuredClone(value) as T;
}
