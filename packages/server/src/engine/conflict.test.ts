import { describe, expect, it } from 'vitest';
import { ErrorCode, type ConflictRecord } from '@obsidian-sync/shared';
import { ConflictService } from './conflict.js';
import { InMemoryDataStore } from './store.js';

function seedConflict(store: InMemoryDataStore, overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  const conflict: ConflictRecord = {
    conflictId: 'conflict-1',
    vaultId: 'vault-1',
    fileId: 'file-1',
    kind: 'content',
    baseHash: null,
    oursHash: 'sha256:ours',
    theirsHash: 'sha256:theirs',
    oursVV: { 'device-1': 1 },
    theirsVV: { 'device-2': 1 },
    status: 'open',
    ...overrides,
  };
  store.conflicts.set(conflict.conflictId, structuredClone(conflict));
  return conflict;
}

describe('ConflictService authorization', () => {
  it('rejects claims from viewers', async () => {
    const store = new InMemoryDataStore();
    seedConflict(store);
    store.roles.set(store.roleKey('vault-1', 'user-1'), 'viewer');

    const service = new ConflictService(store);

    await expect(service.claim('vault-1', 'user-1', 'device-1', 'conflict-1')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('does not reopen resolved conflicts on release', async () => {
    const store = new InMemoryDataStore();
    seedConflict(store, { status: 'resolved', claimedBy: 'device-1' });
    store.roles.set(store.roleKey('vault-1', 'user-1'), 'editor');

    const service = new ConflictService(store);

    await expect(service.release('vault-1', 'user-1', 'device-1', 'conflict-1')).rejects.toMatchObject({
      code: ErrorCode.CONFLICT_ALREADY_RESOLVED,
    });
  });
});

describe('InMemoryDataStore.hasContentForVault', () => {
  it('allows historical op hashes and conflict-side hashes owned by the vault', async () => {
    const store = new InMemoryDataStore();
    await store.appendOp({
      vaultId: 'vault-1',
      seq: 1,
      opId: 'op-1',
      deviceId: 'device-1',
      deviceSeq: 1,
      fileId: 'file-1',
      kind: 'update',
      payload: {
        schemaVersion: 1,
        opId: 'op-1',
        deviceId: 'device-1',
        deviceSeq: 1,
        vaultId: 'vault-1',
        fileId: 'file-1',
        kind: 'update',
        type: 'note',
        contentHash: 'sha256:history',
        inlineText: 'before',
        size: 6,
        baseContentVV: {},
        newContentVV: { 'device-1': 1 },
      },
      result: { type: 'ack', opId: 'op-1', vaultSeq: 1, resultingClocks: { contentVV: { 'device-1': 1 }, epoch: 0 } },
      createdAt: new Date(),
    });
    seedConflict(store, { oursHash: 'sha256:conflict-side', theirsHash: null });

    await expect(store.hasContentForVault('vault-1', 'sha256:history')).resolves.toBe(true);
    await expect(store.hasContentForVault('vault-1', 'sha256:conflict-side')).resolves.toBe(true);
    await expect(store.hasContentForVault('vault-2', 'sha256:history')).resolves.toBe(false);
  });
});
