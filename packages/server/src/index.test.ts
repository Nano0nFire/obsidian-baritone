import { describe, expect, it } from 'vitest';
import { contentHashText } from '@obsidian-sync/shared';
import { AuthService } from './auth/service.js';
import { TokenService, type RefreshTokenRecord, type TokenRepository } from './auth/tokens.js';
import { BlobStore } from './blob/store.js';
import { ConflictService } from './engine/conflict.js';
import { OpProcessor } from './engine/op-processor.js';
import { InMemoryDataStore, type BlobRecord, type Role } from './engine/store.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const otherDevice = '44444444-4444-4444-8444-444444444444';
const fileId = '55555555-5555-4555-8555-555555555555';

function store(): InMemoryDataStore {
  const s = new InMemoryDataStore();
  s.devices.set(deviceId, { deviceId, userId, vaultId, lastDeviceSeq: 0, lastSeq: 0, revoked: false });
  s.devices.set(otherDevice, { deviceId: otherDevice, userId, vaultId, lastDeviceSeq: 0, lastSeq: 0, revoked: false });
  s.roles.set(s.roleKey(vaultId, userId), 'editor');
  return s;
}

async function createNote(processor: OpProcessor, seq = 1, path = 'A.md') {
  const hash = await contentHashText('hello');
  return processor.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: seq, fileId, vaultId, kind: 'create', type: 'note', newPath: path, pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: hash, inlineText: 'hello', size: 5 }, userId);
}

describe('op processor', () => {
  it('is idempotent by op id', async () => {
    const s = store(); const p = new OpProcessor(s);
    const opId = crypto.randomUUID(); const hash = await contentHashText('hello');
    const op = { opId, deviceId, deviceSeq: 1, fileId, vaultId, kind: 'create' as const, type: 'note' as const, newPath: 'A.md', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: hash, inlineText: 'hello', size: 5 };
    const a = await p.process(op, userId);
    const b = await p.process(op, userId);
    expect(b).toEqual(a);
    expect(s.opsById.size).toBe(1);
  });

  it('rejects future device sequence gaps', async () => {
    const result = await new OpProcessor(store()).process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'delete', type: 'note' }, userId);
    expect(result).toMatchObject({ type: 'reject', code: 'SEQ_GAP' });
  });

  it('accepts dominating VV and creates conflict for concurrent VV', async () => {
    const s = store(); const p = new OpProcessor(s);
    await createNote(p);
    const h2 = await contentHashText('new');
    const ok = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'update', type: 'note', newContentVV: { [deviceId]: 2 }, contentHash: h2, inlineText: 'new', size: 3 }, userId);
    expect(ok.type).toBe('ack');
    s.devices.set(otherDevice, { deviceId: otherDevice, userId, vaultId, lastDeviceSeq: 0, lastSeq: 0, revoked: false });
    const h3 = await contentHashText('other');
    const conflict = await p.process({ opId: crypto.randomUUID(), deviceId: otherDevice, deviceSeq: 1, fileId, vaultId, kind: 'update', type: 'note', newContentVV: { [deviceId]: 1, [otherDevice]: 1 }, contentHash: h3, inlineText: 'other', size: 5 }, userId);
    expect(conflict).toMatchObject({ type: 'ack' });
    expect(conflict.type === 'ack' && conflict.conflictId).toBeTruthy();
  });

  it('uses Lamport LWW for rename', async () => {
    const s = store(); const p = new OpProcessor(s); await createNote(p);
    await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'rename', type: 'note', newPath: 'B.md', pathClock: { lamport: 2, deviceId } }, userId);
    await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 3, fileId, vaultId, kind: 'rename', type: 'note', newPath: 'C.md', pathClock: { lamport: 1, deviceId } }, userId);
    expect((await s.getFile(vaultId, fileId))!.path).toBe('B.md');
  });

  it('deletes and restores as a new epoch', async () => {
    const s = store(); const p = new OpProcessor(s); await createNote(p);
    await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'delete', type: 'note', newContentVV: { [deviceId]: 2 } }, userId);
    const restored = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 3, fileId, vaultId, kind: 'restore', type: 'note', newContentVV: { [deviceId]: 3 } }, userId);
    expect(restored.type === 'ack' && restored.resultingClocks.epoch).toBe(1);
    expect((await s.getFile(vaultId, fileId))!.deleted).toBe(false);
  });

  it('suffixes path collisions', async () => {
    const s = store(); const p = new OpProcessor(s); await createNote(p, 1, 'Same.md');
    const second = '66666666-6666-4666-8666-666666666666';
    const h = await contentHashText('x');
    await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId: second, vaultId, kind: 'create', type: 'note', newPath: 'same.md', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 2 }, contentHash: h, inlineText: 'x', size: 1 }, userId);
    expect((await s.getFile(vaultId, second))!.path).toBe('same (2).md');
  });
});

describe('op processor guards', () => {
  it('returns STALE when a past device seq has no stored op', async () => {
    const s = store();
    s.devices.set(deviceId, { deviceId, userId, vaultId, lastDeviceSeq: 5, lastSeq: 5, revoked: false });
    const p = new OpProcessor(s);
    const result = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 3, fileId, vaultId, kind: 'delete', type: 'note' }, userId);
    expect(result).toMatchObject({ type: 'reject', code: 'STALE', details: { expected: 6 } });
  });

  it('replays the stored result for an already-processed device seq', async () => {
    const s = store(); const p = new OpProcessor(s);
    const first = await createNote(p, 1, 'Replay.md');
    const replayOp = { opId: crypto.randomUUID(), deviceId, deviceSeq: 1, fileId, vaultId, kind: 'create' as const, type: 'note' as const, newPath: 'Replay.md', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: await contentHashText('hello'), inlineText: 'hello', size: 5 };
    const replay = await p.process(replayOp, userId);
    expect(replay).toEqual(first);
    expect(s.opsById.size).toBe(1);
  });

  it('forbids writes from viewers', async () => {
    const s = store(); s.roles.set(s.roleKey(vaultId, userId), 'viewer');
    const result = await createNote(new OpProcessor(s));
    expect(result).toMatchObject({ type: 'reject', code: 'FORBIDDEN' });
  });

  it('rejects revoked devices', async () => {
    const s = store(); s.devices.set(deviceId, { deviceId, userId, vaultId, lastDeviceSeq: 0, lastSeq: 0, revoked: true });
    const result = await createNote(new OpProcessor(s));
    expect(result).toMatchObject({ type: 'reject', code: 'DEVICE_REVOKED' });
  });

  it('rejects ops from devices that do not belong to the vault', async () => {
    const s = store(); s.devices.delete(deviceId);
    const result = await createNote(new OpProcessor(s));
    expect(result).toMatchObject({ type: 'reject', code: 'UNAUTHENTICATED' });
  });

  it('freezes content ops while the file is active in Layer 2', async () => {
    const s = store(); const p = new OpProcessor(s); await createNote(p);
    const file = (await s.getFile(vaultId, fileId))!;
    await s.saveFile({ ...file, activeUntil: new Date(Date.now() + 60_000) });
    const result = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'update', type: 'note', newContentVV: { [deviceId]: 2 }, contentHash: await contentHashText('x'), inlineText: 'x', size: 1 }, userId);
    expect(result).toMatchObject({ type: 'reject', code: 'FILE_ACTIVE' });
  });

  it('freezes content ops while a conflict is pending', async () => {
    const s = store(); const p = new OpProcessor(s); await createNote(p);
    const file = (await s.getFile(vaultId, fileId))!;
    await s.saveFile({ ...file, conflictId: 'pending-conflict' });
    const result = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'update', type: 'note', newContentVV: { [deviceId]: 2 }, contentHash: await contentHashText('x'), inlineText: 'x', size: 1 }, userId);
    expect(result).toMatchObject({ type: 'reject', code: 'CONFLICT_PENDING' });
  });

  it('rejects inline content whose hash does not match', async () => {
    const s = store(); const p = new OpProcessor(s);
    const result = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 1, fileId, vaultId, kind: 'create', type: 'note', newPath: 'Bad.md', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: await contentHashText('expected'), inlineText: 'actual-different', size: 5 }, userId);
    expect(result).toMatchObject({ type: 'reject', code: 'BLOB_HASH_MISMATCH' });
  });

  it('rejects content ops that reference an unverified blob', async () => {
    const s = store(); const p = new OpProcessor(s);
    const blobHash = 'sha256:' + 'b'.repeat(64);
    const result = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 1, fileId, vaultId, kind: 'create', type: 'attachment', newPath: 'img.png', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: blobHash, blobRef: blobHash, size: 10 }, userId);
    expect(result).toMatchObject({ type: 'reject', code: 'BLOB_MISSING' });
  });
});

describe('op processor blob lifecycle', () => {
  it('accepts a verified blob reference and registers a live ref', async () => {
    const s = store(); const p = new OpProcessor(s);
    const blobHash = 'sha256:' + 'c'.repeat(64);
    await s.saveBlob({ hash: blobHash, size: 10, state: 'verified', objectKey: 'k', createdAt: new Date(), verifiedAt: new Date(), unreferencedAt: null, deletedAt: null });
    const result = await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 1, fileId, vaultId, kind: 'create', type: 'attachment', newPath: 'img.png', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: blobHash, blobRef: blobHash, size: 10 }, userId);
    expect(result.type).toBe('ack');
    expect(await s.listBlobRefs(blobHash)).toContainEqual({ hash: blobHash, refType: 'file_live', refId: fileId });
  });

  it('moves the live blob ref when content is replaced', async () => {
    const s = store(); const p = new OpProcessor(s);
    const first = 'sha256:' + 'd'.repeat(64); const second = 'sha256:' + 'e'.repeat(64);
    for (const h of [first, second]) await s.saveBlob({ hash: h, size: 10, state: 'verified', objectKey: h, createdAt: new Date(), verifiedAt: new Date(), unreferencedAt: null, deletedAt: null });
    await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 1, fileId, vaultId, kind: 'create', type: 'attachment', newPath: 'a.png', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: first, blobRef: first, size: 10 }, userId);
    await p.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'update', type: 'attachment', newContentVV: { [deviceId]: 2 }, contentHash: second, blobRef: second, size: 10 }, userId);
    expect(await s.listBlobRefs(first)).toEqual([]);
    expect(await s.listBlobRefs(second)).toContainEqual({ hash: second, refType: 'file_live', refId: fileId });
  });
});

describe('conflict service', () => {
  it('resolves with VV join plus synthetic bump', async () => {
    const s = store(); const p = new OpProcessor(s); await createNote(p);
    const conflict = await s.createConflict({ vaultId, fileId, kind: 'content', baseHash: null, oursHash: null, theirsHash: null, oursVV: { a: 1 }, theirsVV: { b: 2 } });
    await new ConflictService(s).claim(conflict.conflictId, deviceId);
    const resolved = await new ConflictService(s).resolve({ conflictId: conflict.conflictId, deviceId, inlineText: 'merged', resolvedVV: { c: 1 } });
    expect(resolved.status).toBe('resolved');
    expect((await s.getFile(vaultId, fileId))!.contentVV).toMatchObject({ a: 1, b: 2, c: 1, [deviceId]: 1 });
  });
});

describe('blob refcount gc', () => {
  it('keeps referenced blobs and deletes old unreferenced blobs', async () => {
    const s = store();
    const blob: BlobRecord = { hash: 'sha256:' + 'a'.repeat(64), size: 1, state: 'verified', objectKey: 'k', createdAt: new Date(), verifiedAt: new Date(), unreferencedAt: new Date(Date.now() - 1000), deletedAt: null };
    await s.saveBlob(blob); await s.addBlobRef({ hash: blob.hash, refType: 'file_live', refId: fileId });
    const bs = new BlobStore({ endpoint: 'http://127.0.0.1:1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'x' }, s);
    expect(await bs.gcUnreferenced(10, new Date())).toEqual([]);
    await s.removeBlobRef(blob.hash, 'file_live', fileId);
    expect(await bs.gcUnreferenced(10, new Date())).toEqual([blob.hash]);
  });
});

describe('auth roles', () => {
  it('allows owners to add members and rejects viewers for owner actions', async () => {
    const users = new Map<string, { userId: string; username: string; pwHash: string }>();
    const roles = new Map<string, Role>();
    const tokenRepo: TokenRepository = { async saveRefreshToken(_r: RefreshTokenRecord) {}, async getRefreshTokenByHash() { return null; }, async revokeRefreshToken() {} };
    const repo = {
      async createUser(username: string, pwHash: string) { const u = { userId: crypto.randomUUID(), username, pwHash }; users.set(u.userId, u); return u; },
      async getUserByUsername(username: string) { return [...users.values()].find((u) => u.username === username) ?? null; },
      async createVault(name: string, ownerUserId: string) { roles.set(`${vaultId}:${ownerUserId}`, 'owner'); return { vaultId, name }; },
      async setMember(v: string, u: string, r: Role) { roles.set(`${v}:${u}`, r); },
      async getMember(v: string, u: string) { const role = roles.get(`${v}:${u}`); return role ? { role } : null; },
      async createDevice() { return { deviceId }; },
      async getDevice() { return { deviceId, userId, vaultId, revoked: false }; },
    };
    const auth = new AuthService(repo, new TokenService('x'.repeat(32), tokenRepo));
    const owner = await auth.createUser('owner_user', 'strong-password'); await auth.createVault('v', owner.userId);
    const member = await auth.createUser('member_user', 'strong-password'); await auth.addMember(vaultId, owner.userId, member.userId, 'viewer');
    await expect(auth.addMember(vaultId, member.userId, owner.userId, 'viewer')).rejects.toThrow(/Insufficient role/);
  });
});
