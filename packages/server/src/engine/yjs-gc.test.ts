import { describe, expect, it } from 'vitest';
import { selectYjsHistoryRetention } from './yjs-gc.js';

describe('Yjs snapshot history retention selection', () => {
  it('keeps the current version plus the newest retained N and prunes the rest', () => {
    const rows = [
      { versionId: 'old-1', vaultId: 'v', fileId: 'f', roomEpoch: 1, seq: 1, createdAt: new Date('2024-01-01T00:00:00Z').getTime(), reason: 'cadence' as const, isCurrent: false },
      { versionId: 'old-2', vaultId: 'v', fileId: 'f', roomEpoch: 1, seq: 2, createdAt: new Date('2024-01-02T00:00:00Z').getTime(), reason: 'cadence' as const, isCurrent: false },
      { versionId: 'keep-3', vaultId: 'v', fileId: 'f', roomEpoch: 2, seq: 3, createdAt: new Date('2024-01-03T00:00:00Z').getTime(), reason: 'cadence' as const, isCurrent: false },
      { versionId: 'current', vaultId: 'v', fileId: 'f', roomEpoch: 3, seq: 4, createdAt: new Date('2024-01-04T00:00:00Z').getTime(), reason: 'compact' as const, isCurrent: true },
    ];

    expect(selectYjsHistoryRetention(rows, 1)).toEqual({ keepVersionIds: ['current', 'keep-3'], pruneVersionIds: ['old-2', 'old-1'] });
  });
});
