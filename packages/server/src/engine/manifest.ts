import { ErrorCode, isValidContentHash, SyncError, type ManifestPageMessage } from '@obsidian-sync/shared';
import type { ManifestCursor, OpDataStore } from './store.js';

export class ManifestService {
  constructor(private readonly store: OpDataStore, private readonly pageSize = 1000) {}

  encodeCursor(cursor: ManifestCursor | null): string | null {
    return cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : null;
  }

  decodeCursor(cursor?: string): ManifestCursor | null {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as ManifestCursor;
      if (typeof parsed.pathNormalized !== 'string' || typeof parsed.fileId !== 'string') throw new Error('invalid cursor');
      return parsed;
    } catch {
      throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid manifest cursor');
    }
  }

  async page(vaultId: string, cursor?: string): Promise<ManifestPageMessage> {
    const watermarkSeq = await this.store.currentSeq(vaultId);
    const result = await this.store.listManifest(vaultId, this.decodeCursor(cursor), this.pageSize);
    return { t: 'manifest_page', watermarkSeq, items: result.items, nextCursor: this.encodeCursor(result.nextCursor) };
  }

  async getContent(hash: string): Promise<Uint8Array | null> {
    if (!isValidContentHash(hash)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid content hash');
    return this.store.getContent(hash);
  }
}
