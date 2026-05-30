import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { contentHashText, type ClientMessage, type ServerMessage } from "@obsidian-sync/shared";
import type { SyncTransport, TransportState } from "../sync/transport.js";
import { YjsSessionManager, threeWayMerge } from "../sync/yjs-session.js";

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function snapshotFor(text: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return encodeBase64(Y.encodeStateAsUpdate(doc));
}

function textUpdate(text: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return encodeBase64(Y.encodeStateAsUpdate(doc));
}

class FakeTransport {
  readyState: TransportState = "open";
  readonly sent: ClientMessage[] = [];
  private messageListener: ((m: ServerMessage) => void | Promise<void>) | null = null;
  private stateListener: ((s: TransportState) => void) | null = null;
  private waiters: Array<{ type: ServerMessage["t"]; predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  onMessage(listener: (m: ServerMessage) => void | Promise<void>): () => void { this.messageListener = listener; return () => { this.messageListener = null; }; }
  onState(listener: (s: TransportState) => void): () => void { this.stateListener = listener; return () => { this.stateListener = null; }; }
  connect(): void { this.readyState = "open"; this.stateListener?.("open"); }
  close(): void { this.readyState = "closed"; this.stateListener?.("closed"); }
  send(message: ClientMessage): void { this.sent.push(message); }

  waitFor<T extends ServerMessage["t"]>(type: T, predicate: (m: Extract<ServerMessage, { t: T }>) => boolean, timeoutMs = 1_000): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({ type, predicate: predicate as (m: ServerMessage) => boolean, resolve: resolve as (m: ServerMessage) => void, reject, timer });
    });
  }

  async deliver(message: ServerMessage): Promise<void> {
    for (const waiter of [...this.waiters]) {
      if (waiter.type === message.t && waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(message);
      }
    }
    await this.messageListener?.(message);
  }
}

async function openSeeded(manager: YjsSessionManager, transport: FakeTransport, text = "server seed", epoch = 7) {
  const opened = manager.openFile("file-1");
  expect(transport.sent.at(-1)).toEqual({ t: "promote", fileId: "file-1" });
  await transport.deliver({ t: "room_state", fileId: "file-1", roomEpoch: epoch, yjsSnapshot: snapshotFor(text), stateVector: encodeBase64(Y.encodeStateVector(new Y.Doc())) });
  await opened;
  return manager.requireSession("file-1");
}

describe("YjsSessionManager", () => {
  it("seeds a Y.Doc only from the server room_state snapshot", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);

    expect(manager.getText("file-1")).toBeUndefined();
    const session = await openSeeded(manager, transport, "authoritative");

    expect(session.text.toString()).toBe("authoritative");
    expect(manager.getText("file-1")).toBe("authoritative");
  });

  it("sends local Yjs updates with roomEpoch and resolves them on yjs_ack", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    const session = await openSeeded(manager, transport, "a", 3);

    session.text.insert(1, "b");
    const sent = [...transport.sent].reverse().find((m: ClientMessage) => m.t === "yjs_update");

    expect(sent).toMatchObject({ t: "yjs_update", fileId: "file-1", roomEpoch: 3, updateId: 1 });
    expect(manager.outstandingCount("file-1")).toBe(1);
    await manager.handleMessage({ t: "yjs_ack", fileId: "file-1", roomEpoch: 3, updateId: 1, seq: 10 });
    expect(manager.outstandingCount("file-1")).toBe(0);
  });

  it("does not send leave_room until outstanding updates are acked", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport, { ackTimeoutMs: 2_000 });
    const session = await openSeeded(manager, transport, "a", 5);
    session.text.insert(1, "b");

    const leave = manager.leaveFile("file-1");
    await Promise.resolve();
    expect(transport.sent.some((m) => m.t === "leave_room")).toBe(false);

    await manager.handleMessage({ t: "yjs_ack", fileId: "file-1", roomEpoch: 5, updateId: 1, seq: 11 });
    await leave;
    expect(transport.sent.some((m) => m.t === "leave_room" && m.fileId === "file-1" && m.roomEpoch === 5)).toBe(true);
  });

  it("applies incoming relayed updates with remote origin without echoing", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    await openSeeded(manager, transport, "", 6);
    const before = transport.sent.filter((m) => m.t === "yjs_update").length;

    await manager.handleMessage({ t: "yjs_update", fileId: "file-1", roomEpoch: 6, seq: 1, update: textUpdate("remote") });

    expect(manager.getText("file-1")).toBe("remote");
    expect(transport.sent.filter((m) => m.t === "yjs_update")).toHaveLength(before);
  });

  it("re-seeds on a newer epoch and ignores stale updates", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    await openSeeded(manager, transport, "old", 1);

    await manager.handleMessage({ t: "room_state", fileId: "file-1", roomEpoch: 2, yjsSnapshot: snapshotFor("new"), stateVector: encodeBase64(Y.encodeStateVector(new Y.Doc())) });
    await manager.handleMessage({ t: "yjs_update", fileId: "file-1", roomEpoch: 1, seq: 99, update: textUpdate("stale") });

    expect(manager.roomEpoch("file-1")).toBe(2);
    expect(manager.getText("file-1")).toBe("new");
  });

  it("carries unacked local text forward when a new epoch re-seeds", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    const session = await openSeeded(manager, transport, "base", 1);
    session.text.insert(4, " local");
    const beforeReseedUpdates = transport.sent.filter((m) => m.t === "yjs_update").length;

    await manager.handleMessage({ t: "room_state", fileId: "file-1", roomEpoch: 2, yjsSnapshot: snapshotFor("base remote"), stateVector: encodeBase64(Y.encodeStateVector(new Y.Doc())) });

    expect(manager.roomEpoch("file-1")).toBe(2);
    expect(manager.getText("file-1")).toContain("local");
    expect(manager.getText("file-1")).toContain("remote");
    expect(transport.sent.filter((m) => m.t === "yjs_update")).toHaveLength(beforeReseedUpdates + 1);
    expect(transport.sent.some((m) => m.t === "yjs_update" && m.roomEpoch === 2)).toBe(true);
  });

  it("sends yjs_sync with the local state vector on reconnect", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    const session = await openSeeded(manager, transport, "abc", 4);

    manager.handleTransportOpen();
    const sent = [...transport.sent].reverse().find((m: ClientMessage) => m.t === "yjs_sync");

    expect(sent).toMatchObject({ t: "yjs_sync", fileId: "file-1", roomEpoch: 4 });
    expect(sent?.stateVector).toBe(encodeBase64(Y.encodeStateVector(session.doc)));
  });

  it("requests yjs_sync when relayed room sequences have a gap", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    await openSeeded(manager, transport, "", 4);
    await manager.handleMessage({ t: "yjs_update", fileId: "file-1", roomEpoch: 4, seq: 1, update: textUpdate("one") });
    const beforeSyncs = transport.sent.filter((m) => m.t === "yjs_sync").length;

    await manager.handleMessage({ t: "yjs_update", fileId: "file-1", roomEpoch: 4, seq: 3, update: textUpdate("three") });

    expect(transport.sent.filter((m) => m.t === "yjs_sync")).toHaveLength(beforeSyncs + 1);
  });

  it("reconciles matching collab ops as no-ops and differing content through Y.Text", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    await openSeeded(manager, transport, "same", 8);

    const sameHash = await contentHashText("same");
    expect(await manager.reconcileLayer1Content("file-1", "same", sameHash)).toEqual({ active: true, changed: false });
    expect(manager.getText("file-1")).toBe("same");

    const newHash = await contentHashText("some brave new text");
    expect(await manager.reconcileLayer1Content("file-1", "some brave new text", newHash)).toEqual({ active: true, changed: true });
    expect(manager.getText("file-1")).toBe("some brave new text");
  });

  it("tears down session state on room_closed", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    await openSeeded(manager, transport, "bye", 9);

    await manager.handleMessage({ t: "room_closed", fileId: "file-1", roomEpoch: 9, reason: "demoted", finalHash: "hash" });

    expect(manager.hasSession("file-1")).toBe(false);
    expect(manager.getText("file-1")).toBeUndefined();
  });

  it("cleanly merges a diverged epoch re-seed without corrupting non-overlapping edits", async () => {
    const transport = new FakeTransport();
    const manager = new YjsSessionManager(transport as unknown as SyncTransport);
    const session = await openSeeded(manager, transport, "line1\nline2\nline3", 1);

    // Local unacked edit on line3; server (theirs) concurrently edited line1.
    const idx = session.text.toString().lastIndexOf("line3");
    session.text.insert(idx + "line3".length, " EDITED");
    expect(manager.outstandingCount("file-1")).toBe(1);

    await manager.handleMessage({ t: "room_state", fileId: "file-1", roomEpoch: 2, yjsSnapshot: snapshotFor("line1 SERVER\nline2\nline3"), stateVector: encodeBase64(Y.encodeStateVector(new Y.Doc())) });

    // Both edits survive, no conflict markers, no positional corruption.
    expect(manager.getText("file-1")).toBe("line1 SERVER\nline2\nline3 EDITED");
    expect(manager.getText("file-1")).not.toContain("<<<<<<<");
    // The carried-forward local edit is re-sent under the new epoch.
    expect(transport.sent.some((m) => m.t === "yjs_update" && m.roomEpoch === 2)).toBe(true);
  });
});

describe("threeWayMerge", () => {
  it("returns ours unchanged when the server snapshot equals base", () => {
    const result = threeWayMerge("a\nb\nc", "a\nB\nc", "a\nb\nc");
    expect(result).toEqual({ text: "a\nB\nc", conflict: false });
  });

  it("merges non-overlapping edits from both sides cleanly", () => {
    const result = threeWayMerge("a\nb\nc", "A\nb\nc", "a\nb\nC");
    expect(result.conflict).toBe(false);
    expect(result.text).toBe("A\nb\nC");
  });

  it("keeps identical edits from both sides without a conflict", () => {
    const result = threeWayMerge("a\nb\nc", "a\nX\nc", "a\nX\nc");
    expect(result).toEqual({ text: "a\nX\nc", conflict: false });
  });

  it("emits conflict markers (losing no data) when both sides edit the same line differently", () => {
    const result = threeWayMerge("a\nb\nc", "a\nOURS\nc", "a\nTHEIRS\nc");
    expect(result.conflict).toBe(true);
    expect(result.text).toContain("<<<<<<< local");
    expect(result.text).toContain("OURS");
    expect(result.text).toContain("=======");
    expect(result.text).toContain("THEIRS");
    expect(result.text).toContain(">>>>>>> server");
  });
});
