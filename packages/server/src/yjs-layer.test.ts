import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { CONTENT_ENCRYPTION_ENCODING, contentHashText, type ServerMessage } from '@obsidian-sync/shared';
import { OpProcessor } from './engine/op-processor.js';
import { RoomManager, type RoomSink } from './engine/room-manager.js';
import { InMemoryDataStore } from './engine/store.js';
import { InMemoryYjsRoomStore } from './engine/yjs.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const otherDevice = '44444444-4444-4444-8444-444444444444';
const fileId = '55555555-5555-4555-8555-555555555555';

class FakeSink implements RoomSink {
  readonly messages: ServerMessage[] = [];
  backpressured = false;
  constructor(readonly deviceId: string) {}
  send(message: ServerMessage): void { this.messages.push(message); }
  isBackpressured(): boolean { return this.backpressured; }
}

function setup(options: ConstructorParameters<typeof RoomManager>[3] = {}) {
  const store = new InMemoryDataStore();
  store.devices.set(deviceId, { deviceId, userId, vaultId, lastDeviceSeq: 0, lastSeq: 0, revoked: false });
  store.devices.set(otherDevice, { deviceId: otherDevice, userId, vaultId, lastDeviceSeq: 0, lastSeq: 0, revoked: false });
  store.roles.set(store.roleKey(vaultId, userId), 'editor');
  const processor = new OpProcessor(store);
  const yjsStore = new InMemoryYjsRoomStore();
  const broadcasts: Array<{ vaultId: string; ops: unknown[] }> = [];
  const manager = new RoomManager(store, yjsStore, processor, { closingGraceMs: 20, leaseMs: 60_000, broadcastVault: (v, _source, ops) => broadcasts.push({ vaultId: v, ops }), ...options });
  return { store, processor, yjsStore, manager, broadcasts };
}

async function createNote(processor: OpProcessor, text = 'hello') {
  const hash = await contentHashText(text);
  const result = await processor.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 1, fileId, vaultId, kind: 'create', type: 'note', newPath: 'A.md', pathClock: { lamport: 1, deviceId }, newContentVV: { [deviceId]: 1 }, contentHash: hash, inlineText: text, size: text.length }, userId);
  expect(result.type).toBe('ack');
}

function docUpdateFrom(snapshot: string, mutate: (text: Y.Text) => void): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot, 'base64'));
  mutate(doc.getText('obsidian'));
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

function textFromSnapshot(snapshot: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  return doc.getText('obsidian').toString();
}

async function delay(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(5);
}

describe('Yjs Layer 2 room manager', () => {
  it('first promote seeds from Layer 1, assigns epoch, and records lease', async () => {
    const { processor, yjsStore, manager } = setup();
    await createNote(processor);
    const sink = new FakeSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);
    expect(state.roomEpoch).toBe(1);
    const room = await yjsStore.getRoom(vaultId, fileId);
    expect(room).toMatchObject({ active: true, leaseOwner: deviceId, epoch: 1, nextSeq: 1 });
    expect(room?.leaseUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(textFromSnapshot(Buffer.from(state.yjsSnapshot, 'base64'))).toBe('hello');
  });

  it('rejects Layer 2 promote for encrypted content', async () => {
    const { processor, store, manager } = setup();
    await createNote(processor);
    const file = await store.getFile(vaultId, fileId);
    expect(file).not.toBeNull();
    await store.saveFile({ ...file!, contentEncoding: CONTENT_ENCRYPTION_ENCODING });

    await expect(manager.promote(vaultId, fileId, deviceId, userId, new FakeSink(deviceId))).rejects.toThrow(/encrypted content/);
  });



  it('serializes concurrent first promotes into a single runtime room', async () => {
    const { processor, manager } = setup();
    await createNote(processor);
    const a = new FakeSink(deviceId); const b = new FakeSink(otherDevice);
    const [first, second] = await Promise.all([
      manager.promote(vaultId, fileId, deviceId, userId, a),
      manager.promote(vaultId, fileId, otherDevice, userId, b),
    ]);
    expect(first.roomEpoch).toBe(1);
    expect(second.roomEpoch).toBe(1);
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 1, update: first.yjsSnapshot });
    await manager.handleUpdate({ vaultId, fileId, deviceId: otherDevice, userId, roomEpoch: 1, updateId: 2, update: second.yjsSnapshot });
    expect(a.messages).toContainEqual({ t: 'yjs_ack', fileId, roomEpoch: 1, updateId: 1, seq: 1 });
    expect(b.messages).toContainEqual({ t: 'yjs_ack', fileId, roomEpoch: 1, updateId: 2, seq: 2 });
  });

  it('allows a second device to join an active room and receive current room_state', async () => {
    const { processor, manager } = setup();
    await createNote(processor);
    const first = await manager.promote(vaultId, fileId, deviceId, userId, new FakeSink(deviceId));
    const second = await manager.promote(vaultId, fileId, otherDevice, userId, new FakeSink(otherDevice));
    expect(second.roomEpoch).toBe(first.roomEpoch);
    expect(textFromSnapshot(Buffer.from(second.yjsSnapshot, 'base64'))).toBe('hello');
  });

  it('persists update, acks sender, then relays to other participants only with monotonic seq', async () => {
    const { processor, manager, yjsStore } = setup();
    await createNote(processor);
    const a = new FakeSink(deviceId); const b = new FakeSink(otherDevice);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, a);
    await manager.promote(vaultId, fileId, otherDevice, userId, b);
    const update = docUpdateFrom(state.yjsSnapshot, (text) => text.insert(5, ' world'));
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: state.roomEpoch, updateId: 7, update });
    expect(a.messages).toEqual([{ t: 'yjs_ack', fileId, roomEpoch: 1, updateId: 7, seq: 1 }]);
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]).toMatchObject({ t: 'yjs_update', fileId, roomEpoch: 1, seq: 1, update });
    expect(await yjsStore.listUpdates(vaultId, fileId, 1)).toHaveLength(1);
  });

  it('does not advance the in-memory doc, seq, or ack when persistence fails', async () => {
    const { processor, manager, yjsStore } = setup();
    await createNote(processor);
    const a = new FakeSink(deviceId); const b = new FakeSink(otherDevice);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, a);
    await manager.promote(vaultId, fileId, otherDevice, userId, b);

    const original = yjsStore.appendUpdate.bind(yjsStore);
    let failNext = true;
    yjsStore.appendUpdate = async (update) => {
      if (failNext) { failNext = false; throw new Error('disk full'); }
      return original(update);
    };

    const update = docUpdateFrom(state.yjsSnapshot, (text) => text.insert(5, ' world'));
    await expect(manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: state.roomEpoch, updateId: 7, update })).rejects.toThrow('disk full');

    // No ack to sender, no relay to peer, nothing persisted.
    expect(a.messages).toHaveLength(0);
    expect(b.messages).toHaveLength(0);
    expect(await yjsStore.listUpdates(vaultId, fileId, state.roomEpoch)).toHaveLength(0);

    // The live in-memory doc was NOT mutated ahead of durable state.
    const afterFail = await manager.promote(vaultId, fileId, otherDevice, userId, new FakeSink(otherDevice));
    expect(textFromSnapshot(Buffer.from(afterFail.yjsSnapshot, 'base64'))).toBe('hello');

    // The next (successful) update still gets seq 1 — the failed attempt did not consume it.
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: state.roomEpoch, updateId: 8, update });
    expect(a.messages).toEqual([{ t: 'yjs_ack', fileId, roomEpoch: 1, updateId: 8, seq: 1 }]);
    const rejoin = await manager.promote(vaultId, fileId, otherDevice, userId, new FakeSink(otherDevice));
    expect(textFromSnapshot(Buffer.from(rejoin.yjsSnapshot, 'base64'))).toBe('hello world');
  });

  it('rejects stale-epoch updates with a fresh room_state', async () => {
    const { processor, manager } = setup();
    await createNote(processor);
    const sink = new FakeSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: state.roomEpoch - 1, updateId: 1, update: state.yjsSnapshot });
    expect(sink.messages.at(-1)).toMatchObject({ t: 'room_state', fileId, roomEpoch: state.roomEpoch });
  });

  it('enforces authz: viewers cannot update and non-participants are rejected', async () => {
    const { store, processor, manager } = setup();
    await createNote(processor);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, new FakeSink(deviceId));
    store.roles.set(store.roleKey(vaultId, userId), 'viewer');
    await expect(manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: state.roomEpoch, updateId: 1, update: state.yjsSnapshot })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    store.roles.set(store.roleKey(vaultId, userId), 'editor');
    await expect(manager.handleUpdate({ vaultId, fileId, deviceId: otherDevice, userId, roomEpoch: state.roomEpoch, updateId: 2, update: state.yjsSnapshot })).rejects.toMatchObject({ code: 'NOT_PARTICIPANT' });
  });

  it('causes Layer-1 content ops for an active file to be rejected FILE_ACTIVE', async () => {
    const { processor, manager } = setup();
    await createNote(processor);
    await manager.promote(vaultId, fileId, deviceId, userId, new FakeSink(deviceId));
    const hash = await contentHashText('offline');
    const result = await processor.process({ opId: crypto.randomUUID(), deviceId, deviceSeq: 2, fileId, vaultId, kind: 'update', type: 'note', newContentVV: { [deviceId]: 2 }, contentHash: hash, inlineText: 'offline', size: 7 }, userId);
    expect(result).toMatchObject({ type: 'reject', code: 'FILE_ACTIVE' });
  });

  it('demotes after closing grace, broadcasts collab op, and sends room_closed demoted', async () => {
    const { processor, manager, broadcasts } = setup();
    await createNote(processor);
    const sink = new FakeSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: state.roomEpoch, updateId: 1, update: docUpdateFrom(state.yjsSnapshot, (text) => text.insert(5, '!')) });
    await manager.leave(vaultId, fileId, deviceId, state.roomEpoch);
    await waitFor(() => sink.messages.at(-1)?.t === 'room_closed');
    expect(sink.messages.at(-1)).toMatchObject({ t: 'room_closed', reason: 'demoted', fileId, roomEpoch: 1 });
    expect(broadcasts).toHaveLength(1);
    expect((broadcasts[0]!.ops[0] as { op: { deviceId: string; inlineText: string } }).op).toMatchObject({ deviceId: `collab:${fileId}`, inlineText: 'hello!' });
  });



  it('contains auto-close flush failures and reports an error instead of crashing', async () => {
    const { store, processor, manager } = setup();
    await createNote(processor);
    const file = (await store.getFile(vaultId, fileId))!;
    await store.saveFile({ ...file, conflictId: '11111111-1111-4111-8111-999999999999' });
    const sink = new FakeSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);
    await manager.leave(vaultId, fileId, deviceId, state.roomEpoch);
    await waitFor(() => sink.messages.at(-1)?.t === 'error');
    expect(sink.messages.at(-1)).toMatchObject({ t: 'error', code: 'CONFLICT_PENDING' });
  });

  it('sweeps expired empty leases into lease_expired demotion', async () => {
    let now = Date.now();
    const { processor, manager } = setup({ leaseMs: 10, closingGraceMs: 1000, now: () => new Date(now) });
    await createNote(processor);
    const sink = new FakeSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);
    await manager.leave(vaultId, fileId, deviceId, state.roomEpoch);
    now += 20;
    await manager.sweepExpired();
    expect(sink.messages.at(-1)).toMatchObject({ t: 'room_closed', reason: 'lease_expired' });
  });

  it('closes active rooms on delete without flushing collab content', async () => {
    const { processor, manager } = setup();
    await createNote(processor);
    const sink = new FakeSink(deviceId);
    await manager.promote(vaultId, fileId, deviceId, userId, sink);
    await manager.closeDeleted(vaultId, fileId);
    expect(sink.messages.at(-1)).toMatchObject({ t: 'room_closed', reason: 'deleted', fileId });
  });

  it('compacts through a seq and snapshot still reconstructs the doc', async () => {
    const { processor, manager, yjsStore } = setup();
    await createNote(processor);
    const sink = new FakeSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 1, update: docUpdateFrom(state.yjsSnapshot, (text) => text.insert(5, '1')) });
    const state2 = sink.messages[0]!;
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 2, update: docUpdateFrom((state2.t === 'yjs_ack' ? state.yjsSnapshot : state.yjsSnapshot), (text) => text.insert(6, '2')) });
    await manager.compact(vaultId, fileId, 1);
    expect((await yjsStore.listUpdates(vaultId, fileId, 1)).map((u) => u.seq)).toEqual([2]);
    const room = await yjsStore.getRoom(vaultId, fileId);
    expect(room?.compactedThroughSeq).toBe(1);
    expect(textFromSnapshot(room!.snapshot!)).toContain('hello');
  });


  it('captures snapshot history on cadence and restores a prior version round-trip', async () => {
    const { processor, manager, store } = setup({ snapshotEveryUpdates: 2 });
    await createNote(processor, 'a');
    const sink = new FakeSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);

    const local = new Y.Doc();
    Y.applyUpdate(local, Buffer.from(state.yjsSnapshot, 'base64'));
    const localText = local.getText('obsidian');
    let vector = Y.encodeStateVector(local);
    localText.delete(0, localText.length); localText.insert(0, 'b');
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 1, update: Buffer.from(Y.encodeStateAsUpdate(local, vector)).toString('base64') });
    vector = Y.encodeStateVector(local);
    localText.delete(0, localText.length); localText.insert(0, 'c');
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 2, update: Buffer.from(Y.encodeStateAsUpdate(local, vector)).toString('base64') });

    const versions = await manager.listHistory(vaultId, fileId, deviceId, userId, { limit: 10 });
    expect(versions.versions.map((v) => v.seq)).toContain(2);
    const captured = versions.versions.find((v) => v.seq === 2)!;
    expect(await manager.getHistoryText(vaultId, fileId, deviceId, userId, captured.versionId)).toBe('c');

    const initial = versions.versions.find((v) => v.seq === 0)!;
    const restored = await manager.restoreHistoryVersion(vaultId, fileId, deviceId, userId, initial.versionId, '00000000-0000-4000-8000-000000000123');
    expect(restored.text).toBe('a');
    const file = (await store.getFile(vaultId, fileId))!;
    expect(file.contentHash).toBe(await contentHashText('a'));
  });

  it('enforces history authz: viewers can list/fetch but cannot restore', async () => {
    const { processor, manager, store } = setup({ snapshotEveryUpdates: 1 });
    await createNote(processor, 'hello');
    await manager.promote(vaultId, fileId, deviceId, userId, new FakeSink(deviceId));
    const version = (await manager.listHistory(vaultId, fileId, deviceId, userId, { limit: 1 })).versions[0]!;

    store.roles.set(store.roleKey(vaultId, userId), 'viewer');
    await expect(manager.listHistory(vaultId, fileId, deviceId, userId, { limit: 1 })).resolves.toMatchObject({ versions: [expect.objectContaining({ versionId: version.versionId })] });
    await expect(manager.getHistoryText(vaultId, fileId, deviceId, userId, version.versionId)).resolves.toBe('hello');
    await expect(manager.restoreHistoryVersion(vaultId, fileId, deviceId, userId, version.versionId, '00000000-0000-4000-8000-000000000124')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rate-limits updates and rejects oversized decoded updates', async () => {
    const { processor, manager } = setup({ updateRateLimit: { maxUpdates: 1, windowMs: 10_000 } });
    await createNote(processor);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, new FakeSink(deviceId));
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 1, update: state.yjsSnapshot });
    await expect(manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 2, update: state.yjsSnapshot })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const tooLarge = Buffer.alloc(2_000_001).toString('base64');
    await expect(manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: 1, updateId: 3, update: tooLarge })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
