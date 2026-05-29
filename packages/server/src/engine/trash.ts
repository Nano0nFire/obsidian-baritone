import { ErrorCode, SyncError, type FileOp } from '@obsidian-sync/shared';
import { OpProcessor } from './op-processor.js';
import type { OpDataStore } from './store.js';

export class TrashService {
  constructor(private readonly store: OpDataStore, private readonly opProcessor: OpProcessor, private readonly retentionDays: number) {}

  async list(vaultId: string): Promise<Array<{ fileId: string; path: string; deletedAt: number; size: number | null }>> {
    const files = await this.store.listTrash(vaultId, new Date());
    return files.map((f) => ({ fileId: f.fileId, path: f.path, deletedAt: f.deletedAt?.getTime() ?? 0, size: f.size }));
  }

  async restore(op: FileOp, userId?: string) {
    if (op.kind !== 'restore') throw new SyncError(ErrorCode.BAD_REQUEST, 'restore op required');
    return this.opProcessor.process(op, userId);
  }

  async gcEligible(vaultId: string, now = new Date()): Promise<string[]> {
    const cutoff = now.getTime() - this.retentionDays * 86_400_000;
    const files = await this.store.listTrash(vaultId, now);
    return files.filter((f) => f.deletedAt && f.deletedAt.getTime() < cutoff).map((f) => f.fileId);
  }
}
