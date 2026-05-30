import { contentHashText, dominates, ErrorCode, isConcurrent, isValidContentHash, join, normalizePath, pathClockWins, suffixPath, SyncError, type AppliedOp, type FileOp, type PathClock, type ResultingClocks } from '@obsidian-sync/shared';
import { newStoredFile, type BlobRef, type OpAckResult, type OpApplyResult, type OpDataStore, type StoredFile, type StoredOp } from './store.js';

export class OpProcessor {
  constructor(private readonly store: OpDataStore) {}

  async process(op: FileOp, userId?: string): Promise<OpApplyResult> {
    return this.store.withTransaction(async (tx) => {
      const existing = await tx.getOpById(op.opId);
      if (existing) return existing.result;

      const syntheticCollab = op.deviceId === `collab:${op.fileId}`;
      const device = syntheticCollab ? null : await tx.getDevice(op.deviceId);
      if (!syntheticCollab) {
        if (!device || device.vaultId !== op.vaultId) return reject(op.opId, ErrorCode.UNAUTHENTICATED, 'Unknown device for vault');
        if (device.revoked) return reject(op.opId, ErrorCode.DEVICE_REVOKED, 'Device is revoked');
        if (userId) {
          const role = await tx.getRole(op.vaultId, userId);
          if (role !== 'owner' && role !== 'editor') return reject(op.opId, ErrorCode.FORBIDDEN, 'Write permission required');
        }

        const expected = device.lastDeviceSeq + 1;
        if (op.deviceSeq < expected) {
          const prior = await tx.getOpByDeviceSeq(op.deviceId, op.deviceSeq);
          return prior?.result ?? reject(op.opId, ErrorCode.STALE, 'Device sequence already processed', { expected });
        }
        if (op.deviceSeq > expected) return reject(op.opId, ErrorCode.SEQ_GAP, 'Device sequence gap', { expected });
      }

      try {
        await validatePayload(op, tx);
        let file = await tx.getFile(op.vaultId, op.fileId);
        const contentOp = op.kind === 'create' || op.kind === 'update' || op.kind === 'restore';
        if (!syntheticCollab && file?.activeUntil && file.activeUntil > new Date() && contentOp) throw new SyncError(ErrorCode.FILE_ACTIVE, 'File is active in Layer 2', { hint: 'promote' });
        if (file?.conflictId && contentOp) throw new SyncError(ErrorCode.CONFLICT_PENDING, 'Content operations are frozen until conflict resolution');

        let conflictId: string | undefined;
        if (op.kind === 'create') ({ file, conflictId } = await applyCreate(op, file, tx));
        else if (op.kind === 'update') ({ file, conflictId } = await applyUpdate(op, requiredFile(file), tx));
        else if (op.kind === 'rename') file = await applyRename(op, requiredFile(file), tx);
        else if (op.kind === 'delete') file = await applyDelete(op, requiredFile(file));
        else if (op.kind === 'restore') file = await applyRestore(op, requiredFile(file), tx);
        else throw new SyncError(ErrorCode.BAD_REQUEST, `Unsupported op kind ${(op as { kind: string }).kind}`);

        const seq = await tx.nextVaultSeq(op.vaultId);
        const resultingClocks = clocks(file);
        const result: OpAckResult = conflictId ? { type: 'ack', opId: op.opId, vaultSeq: seq, resultingClocks, conflictId } : { type: 'ack', opId: op.opId, vaultSeq: seq, resultingClocks };
        await tx.saveFile(file);
        const storedOp: StoredOp = { vaultId: op.vaultId, seq, opId: op.opId, deviceId: op.deviceId, deviceSeq: op.deviceSeq, fileId: op.fileId, kind: op.kind, payload: op, result, createdAt: new Date() };
        await tx.appendOp(storedOp);
        const applied: AppliedOp = { vaultSeq: seq, op, resultingClocks };
        await tx.appendOutbox(op.vaultId, seq, applied);
        if (device) await tx.saveDevice({ ...device, lastDeviceSeq: op.deviceSeq, lastSeq: seq, lastSeen: new Date() });
        return result;
      } catch (error) {
        if (error instanceof SyncError) return reject(op.opId, error.code, error.message, error.details);
        throw error;
      }
    });
  }
}

async function validatePayload(op: FileOp, tx: OpDataStore): Promise<void> {
  if (!op.opId || !op.deviceId || !op.vaultId || !op.fileId || !Number.isSafeInteger(op.deviceSeq) || op.deviceSeq < 1) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid op identity or sequence');
  if ((op.kind === 'create' || op.kind === 'rename') && !op.newPath) throw new SyncError(ErrorCode.ILLEGAL_PATH, 'newPath is required');
  if (op.newPath) normalizePath(op.newPath);
  if ((op.kind === 'create' || op.kind === 'update' || op.kind === 'restore') && op.contentHash) {
    if (!isValidContentHash(op.contentHash)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid content hash');
    if (op.contentEncoding && op.inlineText !== undefined) throw new SyncError(ErrorCode.BAD_REQUEST, 'Encrypted content must be uploaded as an opaque blob');
    if (op.contentEncoding && !op.blobRef && !(await tx.getContent(op.contentHash))) throw new SyncError(ErrorCode.BAD_REQUEST, 'Encrypted content requires an uploaded blob');
    if (op.inlineText !== undefined) {
      const actual = await contentHashText(op.inlineText);
      if (actual !== op.contentHash) throw new SyncError(ErrorCode.BLOB_HASH_MISMATCH, 'Inline content hash mismatch');
      await tx.putContent(op.contentHash, new TextEncoder().encode(op.inlineText));
    }
    if (op.blobRef) {
      const blob = await tx.getBlob(op.blobRef);
      if (!blob || blob.state !== 'verified' || blob.size !== op.size) throw new SyncError(ErrorCode.BLOB_MISSING, 'Referenced blob is not verified');
    }
  }
}

async function applyCreate(op: FileOp, existing: StoredFile | null, tx: OpDataStore): Promise<{ file: StoredFile; conflictId?: string }> {
  if (existing && !existing.deleted) return applyUpdate(op, existing, tx);
  const path = await uniquePath(tx, op.vaultId, normalizePath(op.newPath ?? op.fileId), op.fileId);
  const pathClock = op.pathClock ?? { lamport: 1, deviceId: op.deviceId };
  const file = newStoredFile(op, path, pathClock);
  await updateBlobRefs(tx, null, file);
  return { file };
}

async function applyUpdate(op: FileOp, file: StoredFile, tx: OpDataStore): Promise<{ file: StoredFile; conflictId?: string }> {
  const newVV = op.newContentVV ?? {};
  if (!dominates(newVV, file.contentVV)) {
    if (isConcurrent(newVV, file.contentVV)) {
      const conflict = await tx.createConflict({ vaultId: op.vaultId, fileId: op.fileId, kind: op.type === 'attachment' ? 'attachment' : 'content', baseHash: op.contentHash ?? null, oursHash: file.contentHash, theirsHash: op.contentHash ?? op.blobRef ?? null, oursVV: file.contentVV, theirsVV: newVV });
      const conflicted = { ...file, conflictId: conflict.conflictId, updatedAt: new Date() };
      await addConflictRefs(tx, conflict.conflictId, file.blobRef ?? null, op.blobRef ?? null);
      return { file: conflicted, conflictId: conflict.conflictId };
    }
    throw new SyncError(ErrorCode.STALE, 'Content version does not dominate stored version');
  }
  const updated = { ...file, contentVV: newVV, contentHash: op.contentHash ?? op.blobRef ?? file.contentHash, size: op.size ?? file.size, blobRef: op.blobRef ?? null, contentEncoding: op.contentEncoding ?? null, deleted: false, deletedAt: null, conflictId: null, updatedAt: new Date() };
  await updateBlobRefs(tx, file, updated);
  return { file: updated };
}

async function applyRename(op: FileOp, file: StoredFile, tx: OpDataStore): Promise<StoredFile> {
  const incoming = requiredPathClock(op.pathClock);
  if (!pathClockWins(incoming, file.pathClock)) return file;
  const path = await uniquePath(tx, op.vaultId, normalizePath(op.newPath ?? file.path), op.fileId);
  return { ...file, path, pathNormalized: path.toLowerCase(), pathClock: incoming, updatedAt: new Date() };
}

async function applyDelete(op: FileOp, file: StoredFile): Promise<StoredFile> {
  const deleteVV = op.newContentVV ?? op.baseContentVV ?? file.contentVV;
  return { ...file, deleteVV, deleted: true, deletedAt: new Date(), updatedAt: new Date() };
}

async function applyRestore(op: FileOp, file: StoredFile, tx: OpDataStore): Promise<StoredFile> {
  const restoredVV = join(file.deleteVV ?? {}, op.newContentVV ?? file.contentVV);
  const path = await uniquePath(tx, op.vaultId, normalizePath(op.newPath ?? file.path), op.fileId);
  const restored = { ...file, path, pathNormalized: path.toLowerCase(), contentVV: restoredVV, contentHash: op.contentHash ?? file.contentHash, size: op.size ?? file.size, blobRef: op.blobRef ?? file.blobRef, contentEncoding: op.contentEncoding ?? file.contentEncoding, deleteVV: null, deleted: false, deletedAt: null, epoch: file.epoch + 1, conflictId: null, updatedAt: new Date() };
  await updateBlobRefs(tx, file, restored);
  return restored;
}

async function uniquePath(tx: OpDataStore, vaultId: string, desired: string, fileId: string): Promise<string> {
  let candidate = desired;
  for (let n = 2; n < 10_000; n += 1) {
    const collision = await tx.findLiveFileByPath(vaultId, candidate.toLowerCase());
    if (!collision || collision.fileId === fileId) return candidate;
    candidate = suffixPath(desired, n);
  }
  throw new SyncError(ErrorCode.ILLEGAL_PATH, 'Unable to allocate a collision-free path');
}

function requiredFile(file: StoredFile | null): StoredFile {
  if (!file) throw new SyncError(ErrorCode.NOT_FOUND, 'File not found');
  return file;
}

function requiredPathClock(clock: PathClock | undefined): PathClock {
  if (!clock || !Number.isSafeInteger(clock.lamport) || clock.lamport < 0 || !clock.deviceId) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid path clock');
  return clock;
}

function clocks(file: StoredFile): ResultingClocks {
  return { contentVV: file.contentVV, pathClock: file.pathClock, deleteVV: file.deleteVV ?? undefined, epoch: file.epoch };
}

function reject(opId: string | undefined, code: ErrorCode, message: string, details?: Record<string, unknown>): OpApplyResult {
  return details ? { type: 'reject', opId, code, message, details } : { type: 'reject', opId, code, message };
}

async function updateBlobRefs(tx: OpDataStore, oldFile: StoredFile | null, newFile: StoredFile): Promise<void> {
  if (oldFile?.blobRef && oldFile.blobRef !== newFile.blobRef) await tx.removeBlobRef(oldFile.blobRef, 'file_live', oldFile.fileId);
  if (newFile.blobRef) await tx.addBlobRef({ hash: newFile.blobRef, refType: 'file_live', refId: newFile.fileId } satisfies BlobRef);
}

async function addConflictRefs(tx: OpDataStore, conflictId: string, ours: string | null, theirs: string | null): Promise<void> {
  if (ours) await tx.addBlobRef({ hash: ours, refType: 'conflict_side', refId: `${conflictId}:ours` });
  if (theirs) await tx.addBlobRef({ hash: theirs, refType: 'conflict_side', refId: `${conflictId}:theirs` });
}
