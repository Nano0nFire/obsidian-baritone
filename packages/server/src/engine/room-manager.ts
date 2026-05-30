import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { bump, contentHashText, ErrorCode, join, SyncError, type AppliedOp, type FileOp, type RoomClosedReason, type RoomStateMessage, type ServerMessage, type VersionVector } from '@obsidian-sync/shared';
import { OpProcessor } from './op-processor.js';
import type { OpDataStore, Role, StoredFile } from './store.js';
import type { PersistedYjsRoom, StoredYjsUpdate, YjsRoomStore } from './yjs.js';

export interface RoomSink {
  deviceId: string;
  send(message: ServerMessage): void;
  isBackpressured?(): boolean;
}

export interface RoomManagerOptions {
  leaseMs?: number;
  closingGraceMs?: number;
  updateRateLimit?: { maxUpdates: number; windowMs: number };
  now?: () => Date;
  broadcastVault?: (vaultId: string, sourceDeviceId: string | null, ops: AppliedOp[]) => void;
}

interface Participant {
  deviceId: string;
  userId: string;
  role: Role;
  sink: RoomSink;
  joinedVV: VersionVector;
  rateWindowStarted: number;
  updatesInWindow: number;
}

interface RuntimeRoom {
  key: string;
  persisted: PersistedYjsRoom;
  doc: Y.Doc;
  participants: Map<string, Participant>;
  closingSinks: Map<string, RoomSink>;
  state: 'active' | 'closing' | 'closed';
  lock: AsyncLock;
  closingTimer?: NodeJS.Timeout;
}

type RoomOpResult = { roomState?: RoomStateMessage; closed?: ServerMessage };

const TEXT_NAME = 'obsidian';
const MAX_UPDATE_BYTES = 2_000_000;
const MAX_SYNC_BYTES = 200_000;

export class RoomManager {
  private readonly rooms = new Map<string, RuntimeRoom>();
  private readonly materializing = new Map<string, Promise<RuntimeRoom>>();
  private readonly leaseMs: number;
  private readonly closingGraceMs: number;
  private readonly updateRateLimit: { maxUpdates: number; windowMs: number };
  private readonly now: () => Date;
  private readonly broadcastVault: (vaultId: string, sourceDeviceId: string | null, ops: AppliedOp[]) => void;

  constructor(
    private readonly data: OpDataStore,
    private readonly roomStore: YjsRoomStore,
    private readonly opProcessor: OpProcessor,
    options: RoomManagerOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.closingGraceMs = options.closingGraceMs ?? 3_000;
    this.updateRateLimit = options.updateRateLimit ?? { maxUpdates: 120, windowMs: 10_000 };
    this.now = options.now ?? (() => new Date());
    this.broadcastVault = options.broadcastVault ?? (() => undefined);
  }

  async promote(vaultId: string, fileId: string, deviceId: string, userId: string, sink: RoomSink): Promise<RoomStateMessage> {
    await this.requireRole(vaultId, deviceId, userId, true);
    const room = await this.materialize(vaultId, fileId);
    return room.lock.run(async () => {
      const file = await this.requiredLiveFile(vaultId, fileId);
      const now = this.now();
      if (!room.persisted.active || room.state === 'closed') await this.activate(room, file, deviceId, now);
      room.state = 'active';
      if (room.closingTimer) clearTimeout(room.closingTimer);
      room.closingTimer = undefined;
      room.persisted.leaseUntil = new Date(now.getTime() + this.leaseMs);
      if (!room.persisted.leaseOwner) room.persisted.leaseOwner = deviceId;
      await this.saveRuntime(room);
      room.closingSinks.delete(deviceId);
      room.participants.set(deviceId, { deviceId, userId, role: await this.requireRole(vaultId, deviceId, userId, false), sink, joinedVV: file.contentVV, rateWindowStarted: now.getTime(), updatesInWindow: 0 });
      return this.roomState(room);
    });
  }

  async handleUpdate(input: { vaultId: string; fileId: string; deviceId: string; userId: string; roomEpoch: number; updateId: number; update: string }): Promise<void> {
    await this.requireRole(input.vaultId, input.deviceId, input.userId, true);
    const decoded = decodeBase64(input.update, MAX_UPDATE_BYTES);
    const room = await this.materialize(input.vaultId, input.fileId);
    await room.lock.run(async () => {
      const stale = await this.rejectIfStale(room, input.roomEpoch, input.deviceId);
      if (stale) return;
      const participant = this.requireParticipant(room, input.deviceId);
      if (participant.role !== 'owner' && participant.role !== 'editor') throw new SyncError(ErrorCode.FORBIDDEN, 'Write permission required');
      this.checkRateLimit(participant);
      const seq = room.persisted.nextSeq;
      const update: StoredYjsUpdate = { vaultId: input.vaultId, fileId: input.fileId, roomEpoch: room.persisted.epoch, seq, deviceId: input.deviceId, update: decoded, createdAt: this.now() };
      // Persist before mutating the authoritative in-memory doc so a failed write
      // cannot leave room.doc ahead of durable state (which late joiners replay from).
      await this.roomStore.appendUpdate(update);
      Y.applyUpdate(room.doc, decoded);
      room.persisted.nextSeq = seq + 1;
      room.persisted.leaseOwner = room.persisted.leaseOwner ?? input.deviceId;
      room.persisted.leaseUntil = new Date(this.now().getTime() + this.leaseMs);
      await this.saveRuntime(room);
      participant.sink.send({ t: 'yjs_ack', fileId: input.fileId, roomEpoch: room.persisted.epoch, updateId: input.updateId, seq });
      const relay = { t: 'yjs_update', fileId: input.fileId, roomEpoch: room.persisted.epoch, seq, update: input.update, from: input.deviceId } as ServerMessage;
      this.relay(room, input.deviceId, relay);
    });
  }

  async handleAwareness(input: { vaultId: string; fileId: string; deviceId: string; roomEpoch: number; state: string }): Promise<void> {
    decodeBase64(input.state, MAX_SYNC_BYTES);
    const room = await this.materialize(input.vaultId, input.fileId);
    await room.lock.run(async () => {
      const stale = await this.rejectIfStale(room, input.roomEpoch, input.deviceId);
      if (stale) return;
      const participant = this.requireParticipant(room, input.deviceId);
      if (participant.sink.isBackpressured?.()) return;
      this.relay(room, input.deviceId, { t: 'yjs_awareness', fileId: input.fileId, roomEpoch: room.persisted.epoch, from: input.deviceId, state: input.state });
    });
  }

  async handleSync(input: { vaultId: string; fileId: string; deviceId: string; roomEpoch: number; stateVector: string }): Promise<void> {
    const vector = decodeBase64(input.stateVector, MAX_SYNC_BYTES);
    const room = await this.materialize(input.vaultId, input.fileId);
    await room.lock.run(async () => {
      const stale = await this.rejectIfStale(room, input.roomEpoch, input.deviceId);
      if (stale) return;
      const participant = this.requireParticipant(room, input.deviceId);
      const diff = Y.encodeStateAsUpdate(room.doc, vector);
      participant.sink.send({ t: 'yjs_update', fileId: input.fileId, roomEpoch: room.persisted.epoch, seq: Math.max(0, room.persisted.nextSeq - 1), update: encodeBase64(diff) });
    });
  }

  async heartbeat(vaultId: string, fileId: string, deviceId: string, roomEpoch: number): Promise<void> {
    const room = await this.materialize(vaultId, fileId);
    await room.lock.run(async () => {
      const stale = await this.rejectIfStale(room, roomEpoch, deviceId);
      if (stale) return;
      this.requireParticipant(room, deviceId);
      room.persisted.leaseUntil = new Date(this.now().getTime() + this.leaseMs);
      await this.saveRuntime(room);
    });
  }

  async leave(vaultId: string, fileId: string, deviceId: string, roomEpoch: number): Promise<void> {
    const room = await this.materialize(vaultId, fileId);
    await room.lock.run(async () => {
      const stale = await this.rejectIfStale(room, roomEpoch, deviceId);
      if (stale) return;
      this.requireParticipant(room, deviceId);
      const participant = room.participants.get(deviceId);
      if (participant) room.closingSinks.set(deviceId, participant.sink);
      room.participants.delete(deviceId);
      this.scheduleClosingIfEmpty(room);
    });
  }

  async disconnect(deviceId: string): Promise<void> {
    await Promise.all([...this.rooms.values()].map((room) => room.lock.run(async () => {
      const participant = room.participants.get(deviceId);
      if (participant) room.closingSinks.set(deviceId, participant.sink);
      if (room.participants.delete(deviceId)) this.scheduleClosingIfEmpty(room);
    })));
  }

  async demote(vaultId: string, fileId: string, deviceId: string, roomEpoch?: number, reason: RoomClosedReason = 'demoted'): Promise<string | null> {
    const room = await this.materialize(vaultId, fileId);
    return room.lock.run(async () => {
      if (roomEpoch !== undefined && room.persisted.epoch !== roomEpoch) {
        await this.rejectIfStale(room, roomEpoch, deviceId);
        return null;
      }
      return this.demoteLocked(room, reason);
    });
  }

  async closeDeleted(vaultId: string, fileId: string): Promise<void> {
    const room = await this.materialize(vaultId, fileId);
    await room.lock.run(async () => {
      if (room.persisted.active) await this.closeWithoutFlush(room, 'deleted');
    });
  }

  async sweepExpired(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((room) => room.lock.run(async () => {
      if (room.persisted.active && room.participants.size === 0 && room.persisted.leaseUntil && room.persisted.leaseUntil <= this.now()) await this.demoteLocked(room, 'lease_expired');
    })));
  }

  async compact(vaultId: string, fileId: string, throughSeq?: number): Promise<number> {
    const room = await this.materialize(vaultId, fileId);
    return room.lock.run(async () => {
      const seq = throughSeq ?? Math.max(0, room.persisted.nextSeq - 1);
      const snapshot = Y.encodeStateAsUpdate(room.doc);
      const stateVector = Y.encodeStateVector(room.doc);
      await this.roomStore.saveSnapshot({ vaultId, fileId, roomEpoch: room.persisted.epoch, snapshot, stateVector, compactedThroughSeq: seq, createdAt: this.now() });
      await this.roomStore.deleteUpdatesThrough(vaultId, fileId, room.persisted.epoch, seq);
      room.persisted.snapshot = snapshot;
      room.persisted.stateVector = stateVector;
      room.persisted.compactedThroughSeq = seq;
      await this.saveRuntime(room);
      return seq;
    });
  }

  private async activate(room: RuntimeRoom, file: StoredFile, deviceId: string, now: Date): Promise<void> {
    const nextEpoch = room.persisted.seeded ? room.persisted.epoch + 1 : Math.max(1, room.persisted.epoch + 1);
    room.doc = new Y.Doc();
    if (room.persisted.snapshot) Y.applyUpdate(room.doc, room.persisted.snapshot);
    else {
      const bytes = file.contentHash ? await this.data.getContent(file.contentHash) : null;
      if (bytes) room.doc.getText(TEXT_NAME).insert(0, new TextDecoder().decode(bytes));
    }
    room.persisted = {
      vaultId: file.vaultId,
      fileId: file.fileId,
      epoch: nextEpoch,
      active: true,
      seeded: true,
      leaseOwner: deviceId,
      leaseUntil: new Date(now.getTime() + this.leaseMs),
      activationBaseVV: file.contentVV,
      activationBaseHash: file.contentHash,
      nextSeq: 1,
      snapshot: Y.encodeStateAsUpdate(room.doc),
      stateVector: Y.encodeStateVector(room.doc),
      compactedThroughSeq: 0,
    };
    await this.saveRuntime(room);
    await this.roomStore.saveSnapshot({ vaultId: file.vaultId, fileId: file.fileId, roomEpoch: nextEpoch, snapshot: room.persisted.snapshot!, stateVector: room.persisted.stateVector!, compactedThroughSeq: 0, createdAt: now });
  }

  private async demoteLocked(room: RuntimeRoom, reason: RoomClosedReason): Promise<string> {
    if (!room.persisted.active) return room.persisted.activationBaseHash ?? '';
    const text = room.doc.getText(TEXT_NAME).toString();
    const hash = await contentHashText(text);
    const participantVV = [...room.participants.values()].reduce<VersionVector>((acc, p) => join(acc, p.joinedVV), room.persisted.activationBaseVV);
    const vv = bump(participantVV, `collab:${room.persisted.fileId}`);
    const op: FileOp = {
      opId: stableOpId(room.persisted.vaultId, room.persisted.fileId, room.persisted.epoch),
      deviceId: `collab:${room.persisted.fileId}`,
      deviceSeq: room.persisted.epoch,
      fileId: room.persisted.fileId,
      vaultId: room.persisted.vaultId,
      kind: 'update',
      type: 'note',
      baseContentVV: room.persisted.activationBaseVV,
      newContentVV: vv,
      contentHash: hash,
      inlineText: text,
      size: new TextEncoder().encode(text).byteLength,
      schemaVersion: 1,
    };
    const result = await this.opProcessor.process(op);
    if (result.type !== 'ack') throw new SyncError(result.code as ErrorCode, `Collab flush failed: ${result.message}`, result.details);
    this.broadcastVault(room.persisted.vaultId, null, [{ vaultSeq: result.vaultSeq, op, resultingClocks: result.resultingClocks }]);
    const snapshot = Y.encodeStateAsUpdate(room.doc);
    const stateVector = Y.encodeStateVector(room.doc);
    await this.roomStore.saveSnapshot({ vaultId: room.persisted.vaultId, fileId: room.persisted.fileId, roomEpoch: room.persisted.epoch, snapshot, stateVector, compactedThroughSeq: room.persisted.nextSeq - 1, createdAt: this.now() });
    room.persisted = { ...room.persisted, active: false, leaseOwner: null, leaseUntil: null, snapshot, stateVector, compactedThroughSeq: room.persisted.nextSeq - 1 };
    await this.saveRuntime(room);
    const closed: ServerMessage = { t: 'room_closed', fileId: room.persisted.fileId, roomEpoch: room.persisted.epoch, reason, finalHash: hash };
    this.broadcastRoom(room, closed, true);
    room.participants.clear();
    room.closingSinks.clear();
    room.state = 'closed';
    const file = await this.data.getFile(room.persisted.vaultId, room.persisted.fileId);
    if (file?.activeUntil) await this.data.saveFile({ ...file, activeUntil: null });
    return hash;
  }

  private async closeWithoutFlush(room: RuntimeRoom, reason: RoomClosedReason): Promise<void> {
    room.persisted = { ...room.persisted, active: false, leaseOwner: null, leaseUntil: null };
    await this.saveRuntime(room);
    this.broadcastRoom(room, { t: 'room_closed', fileId: room.persisted.fileId, roomEpoch: room.persisted.epoch, reason }, true);
    room.participants.clear();
    room.closingSinks.clear();
    room.state = 'closed';
    const file = await this.data.getFile(room.persisted.vaultId, room.persisted.fileId);
    if (file?.activeUntil) await this.data.saveFile({ ...file, activeUntil: null });
  }

  private async materialize(vaultId: string, fileId: string): Promise<RuntimeRoom> {
    const key = roomKey(vaultId, fileId);
    const existing = this.rooms.get(key);
    if (existing) return existing;
    const pending = this.materializing.get(key);
    if (pending) return pending;
    const created = this.loadRuntime(vaultId, fileId, key);
    this.materializing.set(key, created);
    try {
      return await created;
    } finally {
      this.materializing.delete(key);
    }
  }

  private async loadRuntime(vaultId: string, fileId: string, key: string): Promise<RuntimeRoom> {
    const existing = this.rooms.get(key);
    if (existing) return existing;
    const persisted = await this.roomStore.getRoom(vaultId, fileId) ?? emptyRoom(vaultId, fileId);
    const doc = new Y.Doc();
    if (persisted.snapshot) Y.applyUpdate(doc, persisted.snapshot);
    const updates = persisted.seeded ? await this.roomStore.listUpdates(vaultId, fileId, persisted.epoch, persisted.compactedThroughSeq) : [];
    for (const update of updates) Y.applyUpdate(doc, update.update);
    const room: RuntimeRoom = { key, persisted, doc, participants: new Map(), closingSinks: new Map(), state: persisted.active ? 'active' : 'closed', lock: new AsyncLock() };
    const winner = this.rooms.get(key);
    if (winner) return winner;
    this.rooms.set(key, room);
    return room;
  }

  private async saveRuntime(room: RuntimeRoom): Promise<void> {
    await this.roomStore.saveRoom(room.persisted);
    const file = await this.data.getFile(room.persisted.vaultId, room.persisted.fileId);
    if (file) await this.data.saveFile({ ...file, activeUntil: room.persisted.active ? room.persisted.leaseUntil : null });
  }

  private scheduleClosingIfEmpty(room: RuntimeRoom): void {
    if (room.participants.size > 0 || !room.persisted.active) return;
    room.state = 'closing';
    if (room.closingTimer) clearTimeout(room.closingTimer);
    room.closingTimer = setTimeout(() => {
      void room.lock.run(async () => {
        try {
          if (room.participants.size === 0 && room.persisted.active) await this.demoteLocked(room, 'demoted');
        } catch (error) {
          room.state = 'active';
          this.broadcastRoom(room, errorToRoomMessage(error), true);
        }
      });
    }, this.closingGraceMs);
    room.closingTimer.unref?.();
  }

  private async rejectIfStale(room: RuntimeRoom, epoch: number, deviceId: string): Promise<RoomOpResult | null> {
    const participant = room.participants.get(deviceId);
    if (room.persisted.active && room.persisted.epoch !== epoch) {
      if (participant) safeSend(participant.sink, this.roomState(room));
      return { roomState: this.roomState(room) };
    }
    if (!room.persisted.active || room.state === 'closed') {
      if (participant) safeSend(participant.sink, { t: 'room_closed', fileId: room.persisted.fileId, roomEpoch: epoch, reason: 'epoch_stale' });
      return { closed: { t: 'room_closed', fileId: room.persisted.fileId, roomEpoch: epoch, reason: 'epoch_stale' } };
    }
    return null;
  }

  private requireParticipant(room: RuntimeRoom, deviceId: string): Participant {
    const participant = room.participants.get(deviceId);
    if (!participant) throw new SyncError(ErrorCode.NOT_PARTICIPANT, 'Device is not a room participant');
    return participant;
  }

  private checkRateLimit(participant: Participant): void {
    const now = this.now().getTime();
    if (now - participant.rateWindowStarted >= this.updateRateLimit.windowMs) {
      participant.rateWindowStarted = now;
      participant.updatesInWindow = 0;
    }
    participant.updatesInWindow += 1;
    if (participant.updatesInWindow > this.updateRateLimit.maxUpdates) throw new SyncError(ErrorCode.RATE_LIMITED, 'Too many Yjs updates');
  }

  private relay(room: RuntimeRoom, sourceDeviceId: string, message: ServerMessage): void {
    for (const participant of room.participants.values()) {
      if (participant.deviceId !== sourceDeviceId && !participant.sink.isBackpressured?.()) safeSend(participant.sink, message);
    }
  }

  private broadcastRoom(room: RuntimeRoom, message: ServerMessage, includeBackpressured: boolean): void {
    const sinks = [...room.participants.values()].map((p) => p.sink);
    for (const sink of room.closingSinks.values()) if (!sinks.includes(sink)) sinks.push(sink);
    for (const sink of sinks) if (includeBackpressured || !sink.isBackpressured?.()) safeSend(sink, message);
  }

  private roomState(room: RuntimeRoom): RoomStateMessage {
    return { t: 'room_state', fileId: room.persisted.fileId, roomEpoch: room.persisted.epoch, yjsSnapshot: encodeBase64(Y.encodeStateAsUpdate(room.doc)), stateVector: encodeBase64(Y.encodeStateVector(room.doc)) };
  }

  private async requiredLiveFile(vaultId: string, fileId: string): Promise<StoredFile> {
    const file = await this.data.getFile(vaultId, fileId);
    if (!file || file.deleted) throw new SyncError(ErrorCode.NOT_FOUND, 'File not found');
    return file;
  }

  private async requireRole(vaultId: string, deviceId: string, userId: string, editor: boolean): Promise<Role> {
    const device = await this.data.getDevice(deviceId);
    if (!device || device.vaultId !== vaultId || device.revoked) throw new SyncError(ErrorCode.UNAUTHENTICATED, 'Invalid device');
    const role = await this.data.getRole(vaultId, userId);
    if (!role) throw new SyncError(ErrorCode.FORBIDDEN, 'No vault role');
    if (editor && role !== 'owner' && role !== 'editor') throw new SyncError(ErrorCode.FORBIDDEN, 'Write permission required');
    return role;
  }
}

class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function emptyRoom(vaultId: string, fileId: string): PersistedYjsRoom {
  return { vaultId, fileId, epoch: 0, active: false, seeded: false, leaseOwner: null, leaseUntil: null, activationBaseVV: {}, activationBaseHash: null, nextSeq: 1, snapshot: null, stateVector: null, compactedThroughSeq: 0 };
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const buffer = Buffer.from(value, 'base64');
  if (buffer.byteLength > maxBytes) throw new SyncError(ErrorCode.PAYLOAD_TOO_LARGE, 'Yjs payload too large');
  return new Uint8Array(buffer);
}
function encodeBase64(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }
function roomKey(vaultId: string, fileId: string): string { return `${vaultId}:${fileId}`; }
function safeSend(sink: RoomSink, message: ServerMessage): void {
  try {
    sink.send(message);
  } catch {
    // A failed sink must not break room serialization or timer cleanup.
  }
}

function errorToRoomMessage(error: unknown): ServerMessage {
  if (error instanceof SyncError) return { t: 'error', ...error.toWire() };
  return { t: 'error', code: ErrorCode.INTERNAL, message: error instanceof Error ? error.message : 'Room close failed' };
}

function stableOpId(vaultId: string, fileId: string, epoch: number): string {
  const hex = createHash('sha256').update(`${vaultId}:${fileId}:${epoch}`).digest('hex').slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}
