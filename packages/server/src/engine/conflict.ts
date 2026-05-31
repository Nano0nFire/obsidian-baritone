import { bump, contentHashText, ErrorCode, isValidContentHash, join, SyncError, type ConflictRecord, type VersionVector } from '@obsidian-sync/shared';
import type { OpDataStore } from './store.js';

export class ConflictService {
  constructor(private readonly store: OpDataStore, private readonly leaseMs = 5 * 60_000) {}

  async claim(vaultId: string, userId: string, deviceId: string, conflictId: string): Promise<ConflictRecord> {
    return this.store.withTransaction(async (tx) => {
      const conflict = await tx.getConflict(conflictId);
      if (!conflict) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
      await requireConflictAccess(tx, conflict, vaultId, userId, true);
      if (conflict.status === 'resolved') throw new SyncError(ErrorCode.CONFLICT_ALREADY_RESOLVED, 'Conflict already resolved');
      if (conflict.status === 'claimed' && conflict.claimedBy && conflict.claimedBy !== deviceId) throw new SyncError(ErrorCode.FORBIDDEN, 'Conflict is claimed by another device');
      const claimed: ConflictRecord = { ...conflict, status: 'claimed', claimedBy: deviceId };
      if (!(await tx.compareAndSetConflict(claimed, { status: conflict.status, claimedBy: conflict.claimedBy ?? null }))) {
        const latest = await tx.getConflict(conflictId);
        if (!latest) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
        if (latest.status === 'resolved') throw new SyncError(ErrorCode.CONFLICT_ALREADY_RESOLVED, 'Conflict already resolved');
        if (latest.claimedBy && latest.claimedBy !== deviceId) throw new SyncError(ErrorCode.FORBIDDEN, 'Conflict is claimed by another device');
        throw new SyncError(ErrorCode.CONFLICT_NOT_CLAIMED, 'Conflict claim changed concurrently');
      }
      return claimed;
    });
  }

  async release(vaultId: string, userId: string, deviceId: string, conflictId: string): Promise<ConflictRecord> {
    const conflict = await this.store.getConflict(conflictId);
    if (!conflict) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
    await requireConflictAccess(this.store, conflict, vaultId, userId, true);
    if (conflict.status === 'resolved') throw new SyncError(ErrorCode.CONFLICT_ALREADY_RESOLVED, 'Conflict already resolved');
    if (conflict.claimedBy !== deviceId) throw new SyncError(ErrorCode.CONFLICT_NOT_CLAIMED, 'Conflict not claimed by this device');
    const released: ConflictRecord = { ...conflict, status: 'open', claimedBy: undefined };
    if (!(await this.store.compareAndSetConflict(released, { status: conflict.status, claimedBy: deviceId }))) {
      const latest = await this.store.getConflict(conflictId);
      if (!latest) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
      if (latest.status === 'resolved') throw new SyncError(ErrorCode.CONFLICT_ALREADY_RESOLVED, 'Conflict already resolved');
      throw new SyncError(ErrorCode.CONFLICT_NOT_CLAIMED, 'Conflict not claimed by this device');
    }
    return released;
  }

  async resolve(input: { vaultId: string; userId: string; conflictId: string; deviceId: string; resolvedHash?: string; inlineText?: string; resolvedVV: VersionVector; allowPendingResolvedHash?: boolean }): Promise<ConflictRecord> {
    return this.store.withTransaction(async (tx) => {
      const conflict = await tx.getConflict(input.conflictId);
      if (!conflict) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
      await requireConflictAccess(tx, conflict, input.vaultId, input.userId, true);
      if (conflict.status === 'resolved') return conflict;
      if (conflict.claimedBy !== input.deviceId) throw new SyncError(ErrorCode.CONFLICT_NOT_CLAIMED, 'Conflict must be claimed before resolving');
      const file = await tx.getFile(conflict.vaultId, conflict.fileId);
      if (!file) throw new SyncError(ErrorCode.NOT_FOUND, 'File not found');
      if (input.resolvedHash !== undefined && !isValidContentHash(input.resolvedHash)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid resolved hash');
      if (input.resolvedHash !== undefined && input.inlineText !== undefined) throw new SyncError(ErrorCode.BAD_REQUEST, 'Provide either resolvedHash or inlineText, not both');
      const hash = input.resolvedHash ?? (input.inlineText !== undefined ? await contentHashText(input.inlineText) : undefined);
      if (!hash) throw new SyncError(ErrorCode.BAD_REQUEST, 'Resolved content required');

      let newBlobRef: string | null = null;
      let newSize: number | null = file.size;
      if (input.inlineText !== undefined) {
        const bytes = new TextEncoder().encode(input.inlineText);
        await tx.putContent(hash, bytes);
        newSize = bytes.byteLength;
      } else {
        if (!(await tx.hasContentForVault(conflict.vaultId, hash)) && !input.allowPendingResolvedHash) throw new SyncError(ErrorCode.FORBIDDEN, 'Resolved content is not available for this vault');
        const blob = await tx.getBlob(hash);
        if (blob && blob.state === 'verified') {
          newBlobRef = hash;
          newSize = blob.size;
        } else {
          const content = await tx.getContent(hash);
          if (!content) throw new SyncError(ErrorCode.BAD_REQUEST, 'Resolved content not found');
          newSize = content.byteLength;
        }
      }

      const newEncoding = newBlobRef ? file.contentEncoding : null;

      if (conflict.oursHash) await tx.removeBlobRef(conflict.oursHash, 'conflict_side', `${conflict.conflictId}:ours`);
      if (conflict.theirsHash) await tx.removeBlobRef(conflict.theirsHash, 'conflict_side', `${conflict.conflictId}:theirs`);
      if (file.blobRef && file.blobRef !== newBlobRef) await tx.removeBlobRef(file.blobRef, 'file_live', file.fileId);
      if (newBlobRef) await tx.addBlobRef({ hash: newBlobRef, refType: 'file_live', refId: file.fileId });

      const joined = bump(join(join(conflict.oursVV ?? {}, conflict.theirsVV ?? {}), input.resolvedVV), input.deviceId);
      const resolved = { ...conflict, status: 'resolved' as const, resolvedBy: input.deviceId, resolvedHash: hash, resolvedVV: joined };
      if (!(await tx.compareAndSetConflict(resolved, { status: conflict.status, claimedBy: input.deviceId }))) {
        const latest = await tx.getConflict(input.conflictId);
        if (!latest) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
        if (latest.status === 'resolved') return latest;
        throw new SyncError(ErrorCode.CONFLICT_NOT_CLAIMED, 'Conflict must be claimed before resolving');
      }
      await tx.saveFile({ ...file, contentHash: hash, blobRef: newBlobRef, size: newSize, contentEncoding: newEncoding, contentVV: joined, conflictId: null, deleted: false, deletedAt: null, updatedAt: new Date() });
      return resolved;
    });
  }
}

async function requireConflictAccess(store: OpDataStore, conflict: ConflictRecord, vaultId: string, userId: string, write: boolean): Promise<void> {
  if (conflict.vaultId !== vaultId) throw new SyncError(ErrorCode.FORBIDDEN, 'Conflict does not belong to this vault');
  const role = await store.getRole(vaultId, userId);
  if (!role || (write && role !== 'owner' && role !== 'editor')) {
    throw new SyncError(ErrorCode.FORBIDDEN, write ? 'Write permission required' : 'Read permission required');
  }
}
