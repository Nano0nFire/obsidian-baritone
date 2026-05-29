import { bump, contentHashText, ErrorCode, join, SyncError, type ConflictRecord, type VersionVector } from '@obsidian-sync/shared';
import type { OpDataStore } from './store.js';

export class ConflictService {
  constructor(private readonly store: OpDataStore, private readonly leaseMs = 5 * 60_000) {}

  async claim(conflictId: string, deviceId: string): Promise<ConflictRecord> {
    return this.store.withTransaction(async (tx) => {
      const conflict = await tx.getConflict(conflictId);
      if (!conflict) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
      if (conflict.status === 'resolved') throw new SyncError(ErrorCode.CONFLICT_ALREADY_RESOLVED, 'Conflict already resolved');
      if (conflict.status === 'claimed' && conflict.claimedBy && conflict.claimedBy !== deviceId) throw new SyncError(ErrorCode.FORBIDDEN, 'Conflict is claimed by another device');
      const claimed: ConflictRecord = { ...conflict, status: 'claimed', claimedBy: deviceId };
      await tx.saveConflict(claimed);
      return claimed;
    });
  }

  async release(conflictId: string, deviceId: string): Promise<ConflictRecord> {
    const conflict = await this.store.getConflict(conflictId);
    if (!conflict) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
    if (conflict.claimedBy !== deviceId) throw new SyncError(ErrorCode.CONFLICT_NOT_CLAIMED, 'Conflict not claimed by this device');
    const released: ConflictRecord = { ...conflict, status: 'open', claimedBy: undefined };
    await this.store.saveConflict(released);
    return released;
  }

  async resolve(input: { conflictId: string; deviceId: string; resolvedHash?: string; inlineText?: string; resolvedVV: VersionVector }): Promise<ConflictRecord> {
    return this.store.withTransaction(async (tx) => {
      const conflict = await tx.getConflict(input.conflictId);
      if (!conflict) throw new SyncError(ErrorCode.NOT_FOUND, 'Conflict not found');
      if (conflict.status === 'resolved') return conflict;
      if (conflict.claimedBy !== input.deviceId) throw new SyncError(ErrorCode.CONFLICT_NOT_CLAIMED, 'Conflict must be claimed before resolving');
      const file = await tx.getFile(conflict.vaultId, conflict.fileId);
      if (!file) throw new SyncError(ErrorCode.NOT_FOUND, 'File not found');
      const hash = input.resolvedHash ?? (input.inlineText !== undefined ? await contentHashText(input.inlineText) : undefined);
      if (!hash) throw new SyncError(ErrorCode.BAD_REQUEST, 'Resolved content required');
      if (input.inlineText !== undefined) await tx.putContent(hash, new TextEncoder().encode(input.inlineText));
      const joined = bump(join(join(conflict.oursVV ?? {}, conflict.theirsVV ?? {}), input.resolvedVV), input.deviceId);
      const resolved = { ...conflict, status: 'resolved' as const, resolvedBy: input.deviceId, resolvedHash: hash, resolvedVV: joined };
      await tx.saveConflict(resolved);
      await tx.saveFile({ ...file, contentHash: hash, contentVV: joined, conflictId: null, deleted: false, deletedAt: null, updatedAt: new Date() });
      return resolved;
    });
  }
}
