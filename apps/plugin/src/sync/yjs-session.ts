import type {
  ClientMessage,
  HistoryListResponseMessage,
  HistoryRestoredMessage,
  HistoryVersionMessage,
  RoomClosedMessage,
  RoomStateMessage,
  ServerMessage,
  SnapshotVersionMetadata,
  YjsAckMessage,
  YjsAwarenessRelayMessage,
  YjsRelayUpdateMessage,
} from "@obsidian-sync/shared";
import { contentHashText } from "@obsidian-sync/shared";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import diff from "fast-diff";
import type { SyncTransport, TransportState } from "./transport.js";

export const YJS_REMOTE_ORIGIN = Symbol("obsidian-sync:yjs-remote");
export const YJS_LAYER1_ORIGIN = Symbol("obsidian-sync:layer1-reconcile");

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function randomUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

interface AckWaiter {
  readonly promise: Promise<void>;
  readonly update: Uint8Array;
  resolve(): void;
  reject(error: Error): void;
}

export interface YjsSession {
  readonly fileId: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly awareness: Awareness;
  readonly createdAt: number;
  roomEpoch: number;
  nextUpdateId: number;
  lastSeq: number;
  ackedText: string;
  outstanding: Map<number, AckWaiter>;
  destroy(): void;
}

export interface YjsSessionManagerOptions {
  readonly ackTimeoutMs?: number;
  readonly textName?: string;
  readonly onSessionChanged?: (fileId: string, session: YjsSession | null) => void;
}

export interface Layer1ReconcileResult {
  readonly active: boolean;
  readonly changed: boolean;
}

function makeAckWaiter(update: Uint8Array): AckWaiter {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  void promise.catch(() => undefined);
  return { promise, update, resolve, reject };
}

function isLayer2Message(message: ServerMessage): message is RoomStateMessage | YjsRelayUpdateMessage | YjsAckMessage | YjsAwarenessRelayMessage | RoomClosedMessage {
  return message.t === "room_state" || message.t === "yjs_update" || message.t === "yjs_ack" || message.t === "yjs_awareness" || message.t === "room_closed";
}

export class YjsSessionManager {
  private readonly sessions = new Map<string, YjsSession>();
  private readonly ackTimeoutMs: number;
  private readonly textName: string;
  private readonly onSessionChanged?: (fileId: string, session: YjsSession | null) => void;

  constructor(private readonly transport: SyncTransport, options: YjsSessionManagerOptions = {}) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000;
    this.textName = options.textName ?? "content";
    this.onSessionChanged = options.onSessionChanged;
  }

  async openFile(fileId: string): Promise<YjsSession> {
    const existing = this.sessions.get(fileId);
    if (existing) return existing;
    const roomState = this.transport.waitFor("room_state", (message) => message.fileId === fileId, 30_000);
    this.transport.send({ t: "promote", fileId });
    return this.handleRoomState(await roomState);
  }

  async leaveFile(fileId: string): Promise<void> {
    const session = this.sessions.get(fileId);
    if (!session) return;
    await this.waitForOutstanding(session);
    this.transport.send({ t: "leave_room", fileId, roomEpoch: session.roomEpoch });
    this.destroySession(fileId);
  }

  async resyncFile(fileId: string): Promise<YjsSession> {
    this.destroySession(fileId);
    return this.openFile(fileId);
  }

  async handleMessage(message: ServerMessage): Promise<boolean> {
    if (!isLayer2Message(message)) return false;
    switch (message.t) {
      case "room_state":
        this.handleRoomState(message);
        break;
      case "yjs_update":
        this.handleYjsUpdate(message);
        break;
      case "yjs_ack":
        this.handleAck(message);
        break;
      case "yjs_awareness":
        this.handleAwareness(message);
        break;
      case "room_closed":
        await this.handleRoomClosed(message);
        break;
    }
    return true;
  }

  handleTransportState(state: TransportState): void {
    if (state === "open") this.handleTransportOpen();
  }

  handleTransportOpen(): void {
    for (const session of this.sessions.values()) {
      this.sendSync(session);
    }
  }

  sendHeartbeat(fileId: string): void {
    const session = this.sessions.get(fileId);
    if (session) this.transport.send({ t: "yjs_heartbeat", fileId, roomEpoch: session.roomEpoch });
  }

  setLocalAwareness(fileId: string, state: Record<string, unknown> | null): void {
    const session = this.sessions.get(fileId);
    if (!session) return;
    session.awareness.setLocalState(state);
  }

  async listHistory(fileId: string, options: { limit?: number; before?: string } = {}): Promise<{ versions: SnapshotVersionMetadata[]; more: boolean }> {
    const requestId = randomUuid();
    const response = this.transport.waitFor("history_list", (message: HistoryListResponseMessage) => message.requestId === requestId && message.fileId === fileId, 30_000);
    this.transport.send({ t: "history_list", requestId, fileId, ...options });
    const page = await response;
    return { versions: page.versions, more: page.more };
  }

  async fetchHistoryText(fileId: string, versionId: string): Promise<string> {
    const requestId = randomUuid();
    const response = this.transport.waitFor("history_version", (message: HistoryVersionMessage) => message.requestId === requestId && message.fileId === fileId && message.versionId === versionId, 30_000);
    this.transport.send({ t: "history_get", requestId, fileId, versionId });
    return (await response).text;
  }

  async restoreHistoryVersion(fileId: string, versionId: string): Promise<string> {
    const requestId = randomUuid();
    const response = this.transport.waitFor("history_restored", (message: HistoryRestoredMessage) => message.requestId === requestId && message.fileId === fileId && message.versionId === versionId, 30_000);
    this.transport.send({ t: "history_restore", requestId, fileId, versionId });
    const restored = await response;
    const session = this.sessions.get(fileId);
    if (session) applyMinimalTextDiff(session.text, session.text.toString(), restored.text, YJS_REMOTE_ORIGIN);
    return restored.text;
  }

  async reconcileLayer1Content(fileId: string, text: string, contentHash?: string): Promise<Layer1ReconcileResult> {
    const session = this.sessions.get(fileId);
    if (!session) return { active: false, changed: false };
    const current = session.text.toString();
    const expectedHash = contentHash ?? await contentHashText(text);
    if (await contentHashText(current) === expectedHash) return { active: true, changed: false };
    applyMinimalTextDiff(session.text, current, text, YJS_LAYER1_ORIGIN);
    return { active: true, changed: true };
  }

  hasSession(fileId: string): boolean { return this.sessions.has(fileId); }
  activeFileIds(): string[] { return [...this.sessions.keys()]; }
  getText(fileId: string): string | undefined { return this.sessions.get(fileId)?.text.toString(); }
  requireSession(fileId: string): YjsSession {
    const session = this.sessions.get(fileId);
    if (!session) throw new Error(`No active Yjs session for ${fileId}`);
    return session;
  }
  roomEpoch(fileId: string): number | undefined { return this.sessions.get(fileId)?.roomEpoch; }
  outstandingCount(fileId: string): number { return this.sessions.get(fileId)?.outstanding.size ?? 0; }

  private handleRoomState(message: RoomStateMessage): YjsSession {
    const existing = this.sessions.get(message.fileId);
    if (existing && existing.roomEpoch === message.roomEpoch) return existing;
    const carryForwardText = existing && existing.outstanding.size > 0
      ? { base: existing.ackedText, current: existing.text.toString() }
      : undefined;
    if (existing) this.destroySession(message.fileId);

    const doc = new Y.Doc();
    const text = doc.getText(this.textName);
    const awareness = new Awareness(doc);
    Y.applyUpdate(doc, decodeBase64(message.yjsSnapshot), YJS_REMOTE_ORIGIN);
    const session: YjsSession = {
      fileId: message.fileId,
      doc,
      text,
      awareness,
      roomEpoch: message.roomEpoch,
      nextUpdateId: 1,
      lastSeq: 0,
      ackedText: text.toString(),
      outstanding: new Map(),
      createdAt: Date.now(),
      destroy: () => {
        removeAwarenessStates(awareness, [doc.clientID], YJS_REMOTE_ORIGIN);
        awareness.destroy();
        doc.destroy();
      },
    };

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === YJS_REMOTE_ORIGIN || origin === YJS_LAYER1_ORIGIN) return;
      this.sendLocalUpdate(session, update);
    });
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === YJS_REMOTE_ORIGIN) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      this.transport.send({
        t: "yjs_awareness",
        fileId: session.fileId,
        roomEpoch: session.roomEpoch,
        state: encodeBase64(encodeAwarenessUpdate(awareness, changed)),
      });
    });
    this.sessions.set(message.fileId, session);
    if (carryForwardText && carryForwardText.base !== carryForwardText.current) {
      const seededText = text.toString();
      const target = seededText === carryForwardText.base
        ? carryForwardText.current
        : threeWayMerge(carryForwardText.base, carryForwardText.current, seededText).text;
      if (target !== seededText) applyMinimalTextDiff(text, seededText, target, undefined);
    }
    this.onSessionChanged?.(message.fileId, session);
    return session;
  }

  private sendLocalUpdate(session: YjsSession, update: Uint8Array): void {
    const updateId = session.nextUpdateId;
    session.nextUpdateId += 1;
    const waiter = makeAckWaiter(update);
    session.outstanding.set(updateId, waiter);
    const message: ClientMessage = { t: "yjs_update", fileId: session.fileId, roomEpoch: session.roomEpoch, updateId, update: encodeBase64(update) };
    this.transport.send(message);
  }

  private handleYjsUpdate(message: YjsRelayUpdateMessage): void {
    const session = this.sessions.get(message.fileId);
    if (!session || message.roomEpoch !== session.roomEpoch) return;
    if (message.seq <= session.lastSeq) return;
    if (session.lastSeq > 0 && message.seq > session.lastSeq + 1) {
      this.sendSync(session);
      return;
    }
    Y.applyUpdate(session.doc, decodeBase64(message.update), YJS_REMOTE_ORIGIN);
    session.lastSeq = message.seq;
    session.ackedText = session.text.toString();
  }

  private sendSync(session: YjsSession): void {
    this.transport.send({
      t: "yjs_sync",
      fileId: session.fileId,
      roomEpoch: session.roomEpoch,
      stateVector: encodeBase64(Y.encodeStateVector(session.doc)),
    });
  }

  private handleAck(message: YjsAckMessage): void {
    const session = this.sessions.get(message.fileId);
    if (!session || message.roomEpoch !== session.roomEpoch) return;
    session.lastSeq = Math.max(session.lastSeq, message.seq);
    const waiter = session.outstanding.get(message.updateId);
    if (!waiter) return;
    session.outstanding.delete(message.updateId);
    session.ackedText = session.text.toString();
    waiter.resolve();
  }

  private handleAwareness(message: YjsAwarenessRelayMessage): void {
    const session = this.sessions.get(message.fileId);
    if (!session || message.roomEpoch !== session.roomEpoch) return;
    applyAwarenessUpdate(session.awareness, decodeBase64(message.state), YJS_REMOTE_ORIGIN);
  }

  private async handleRoomClosed(message: RoomClosedMessage): Promise<void> {
    const session = this.sessions.get(message.fileId);
    if (!session || message.roomEpoch !== session.roomEpoch) return;
    if (message.reason === "epoch_stale") {
      void this.resyncFile(message.fileId).catch(() => undefined);
      return;
    }
    this.destroySession(message.fileId);
  }

  private async waitForOutstanding(session: YjsSession): Promise<void> {
    if (session.outstanding.size === 0) return;
    const acks = [...session.outstanding.values()].map((waiter) => waiter.promise.catch(() => undefined));
    await Promise.race([
      Promise.all(acks),
      new Promise<void>((resolve) => setTimeout(resolve, this.ackTimeoutMs)),
    ]);
    for (const waiter of session.outstanding.values()) waiter.reject(new Error("Timed out waiting for yjs_ack"));
    session.outstanding.clear();
  }

  private destroySession(fileId: string): void {
    const session = this.sessions.get(fileId);
    if (!session) return;
    for (const waiter of session.outstanding.values()) waiter.reject(new Error("Yjs session closed"));
    session.outstanding.clear();
    session.destroy();
    this.sessions.delete(fileId);
    this.onSessionChanged?.(fileId, null);
  }
}

function applyMinimalTextDiff(ytext: Y.Text, oldText: string, newText: string, origin: unknown): void {
  let index = 0;
  ytext.doc?.transact(() => {
    for (const [op, value] of diff(oldText, newText)) {
      if (op === diff.EQUAL) {
        index += value.length;
      } else if (op === diff.DELETE) {
        ytext.delete(index, Math.min(value.length, ytext.length - index));
      } else if (op === diff.INSERT) {
        ytext.insert(index, value);
        index += value.length;
      }
    }
  }, origin);
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function sliceEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1]! + 1) : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

// Line-based diff3 merge. Non-overlapping edits from each side merge cleanly;
// overlapping edits are preserved verbatim inside conflict markers so the user
// resolves them manually (never silently dropped or positionally corrupted).
export function threeWayMerge(baseText: string, oursText: string, theirsText: string): { text: string; conflict: boolean } {
  const base = splitLines(baseText);
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);
  const aMap = new Map<number, number>(lcsPairs(base, ours).map(([o, x]) => [o, x] as [number, number]));
  const bMap = new Map<number, number>(lcsPairs(base, theirs).map(([o, x]) => [o, x] as [number, number]));
  const anchors: Array<{ o: number; a: number; b: number }> = [];
  let lastA = -1;
  let lastB = -1;
  for (let o = 0; o < base.length; o += 1) {
    const a = aMap.get(o);
    const b = bMap.get(o);
    if (a !== undefined && b !== undefined && a > lastA && b > lastB) {
      anchors.push({ o, a, b });
      lastA = a;
      lastB = b;
    }
  }
  const out: string[] = [];
  let conflict = false;
  let oPrev = 0;
  let aPrev = 0;
  let bPrev = 0;
  const emit = (oLo: number, oHi: number, aLo: number, aHi: number, bLo: number, bHi: number): void => {
    const baseSlice = base.slice(oLo, oHi);
    const oursSlice = ours.slice(aLo, aHi);
    const theirsSlice = theirs.slice(bLo, bHi);
    if (sliceEqual(oursSlice, theirsSlice)) out.push(...oursSlice);
    else if (sliceEqual(oursSlice, baseSlice)) out.push(...theirsSlice);
    else if (sliceEqual(theirsSlice, baseSlice)) out.push(...oursSlice);
    else {
      conflict = true;
      out.push("<<<<<<< local", ...oursSlice, "=======", ...theirsSlice, ">>>>>>> server");
    }
  };
  for (const anchor of anchors) {
    emit(oPrev, anchor.o, aPrev, anchor.a, bPrev, anchor.b);
    out.push(base[anchor.o]!);
    oPrev = anchor.o + 1;
    aPrev = anchor.a + 1;
    bPrev = anchor.b + 1;
  }
  emit(oPrev, base.length, aPrev, ours.length, bPrev, theirs.length);
  return { text: out.join("\n"), conflict };
}
