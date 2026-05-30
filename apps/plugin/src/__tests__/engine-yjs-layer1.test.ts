import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { contentHashText, type AppliedOp, type ClientMessage, type FileOp, type ServerMessage } from "@obsidian-sync/shared";
import { SyncEngine } from "../sync/engine.js";
import { YjsSessionManager } from "../sync/yjs-session.js";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";
import type { SyncTransport, TransportState } from "../sync/transport.js";
import type { VaultFileInfo, VaultIO } from "../sync/vault-io.js";
import { DEFAULT_SETTINGS, type PluginSettings } from "../settings.js";

const deviceId = "device-1";

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function snapshotFor(text: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return encodeBase64(Y.encodeStateAsUpdate(doc));
}

function memAdapter(): PluginAdapter {
  const store = new Map<string, string>();
  return {
    async exists(path) { return store.has(path); },
    async read(path) { return store.get(path) ?? ""; },
    async write(path, data) { store.set(path, data); },
    async remove(path) { store.delete(path); },
    async rename(oldPath, newPath) { const value = store.get(oldPath); if (value !== undefined) { store.set(newPath, value); store.delete(oldPath); } },
  };
}

class FakeVault implements VaultIO {
  writes = 0;
  readonly text = new Map<string, string>();
  listFiles(): VaultFileInfo[] { return []; }
  async readText(path: string): Promise<string> { return this.text.get(path) ?? ""; }
  async readBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(this.text.get(path) ?? ""); }
  async writeText(path: string, text: string): Promise<void> { this.writes += 1; this.text.set(path, text); }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> { this.writes += 1; this.text.set(path, new TextDecoder().decode(bytes)); }
  async rename(): Promise<void> {}
  async trash(): Promise<void> {}
  exists(path: string): boolean { return this.text.has(path); }
}

class FakeTransport {
  readyState: TransportState = "open";
  readonly sent: ClientMessage[] = [];
  private messageListener: ((m: ServerMessage) => void | Promise<void>) | null = null;
  onMessage(listener: (m: ServerMessage) => void | Promise<void>): () => void { this.messageListener = listener; return () => { this.messageListener = null; }; }
  onState(): () => void { return () => {}; }
  connect(): void {}
  close(): void {}
  send(message: ClientMessage): void { this.sent.push(message); }
  waitFor<T extends ServerMessage["t"]>(): Promise<Extract<ServerMessage, { t: T }>> { return Promise.reject(new Error("not used")); }
  async deliver(message: ServerMessage): Promise<void> { await this.messageListener?.(message); }
}

function makeContentOp(fileId: string, inlineText: string, contentHash: string): FileOp {
  return {
    opId: `op-${inlineText}`,
    deviceId: "server-device",
    deviceSeq: 1,
    fileId,
    vaultId: "vault-1",
    kind: "update",
    type: "note",
    newContentVV: { remote: 1 },
    contentHash,
    size: new TextEncoder().encode(inlineText).byteLength,
    inlineText,
  };
}

async function makeHarness(seed: string) {
  const transport = new FakeTransport();
  const yjs = new YjsSessionManager(transport as unknown as SyncTransport);
  await yjs.handleMessage({ t: "room_state", fileId: "file-1", roomEpoch: 1, yjsSnapshot: snapshotFor(seed), stateVector: encodeBase64(Y.encodeStateVector(new Y.Doc())) });
  const vault = new FakeVault();
  vault.text.set("note.md", seed);
  const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
  const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
  index.upsertFile({ fileId: "file-1", path: "note.md", type: "note", contentHash: await contentHashText(seed), size: seed.length, appliedContentVV: {}, isDir: false, mtime: 1 });
  const engine = new SyncEngine(settings, index, vault, transport as unknown as SyncTransport, {}, yjs);
  engine.start();
  return { engine, index, transport, vault, yjs };
}

describe("SyncEngine Layer 1 reconciliation while Yjs-active", () => {
  it("treats matching collab content as bookkeeping without rewriting the active editor", async () => {
    const { index, transport, vault, yjs } = await makeHarness("same");
    const hash = await contentHashText("same");
    const applied: AppliedOp = { vaultSeq: 1, op: makeContentOp("file-1", "same", hash), resultingClocks: { contentVV: { remote: 1 }, epoch: 1 } };

    await transport.deliver({ t: "ops", ops: [applied], more: false });

    expect(vault.writes).toBe(0);
    expect(yjs.getText("file-1")).toBe("same");
    expect(index.byFileId("file-1")?.contentHash).toBe(hash);
    expect(index.device.appliedSeq).toBe(1);
  });

  it("reconciles differing collab content through Y.Text without emitting a Layer 1 write", async () => {
    const { transport, vault, yjs } = await makeHarness("old text");
    const next = "old brave new text";
    const hash = await contentHashText(next);
    const beforeYjsUpdates = transport.sent.filter((m) => m.t === "yjs_update").length;
    const applied: AppliedOp = { vaultSeq: 1, op: makeContentOp("file-1", next, hash), resultingClocks: { contentVV: { remote: 1 }, epoch: 1 } };

    await transport.deliver({ t: "ops", ops: [applied], more: false });

    expect(vault.writes).toBe(0);
    expect(yjs.getText("file-1")).toBe(next);
    expect(transport.sent.filter((m) => m.t === "yjs_update")).toHaveLength(beforeYjsUpdates);
  });
});
