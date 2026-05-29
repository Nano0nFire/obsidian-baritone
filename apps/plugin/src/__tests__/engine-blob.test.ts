import { describe, expect, it } from "vitest";
import { contentHash, type AppliedOp, type ClientMessage, type FileOp, type ServerMessage } from "@obsidian-sync/shared";
import { SyncEngine } from "../sync/engine.js";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";
import type { VaultIO, VaultFileInfo } from "../sync/vault-io.js";
import type { SyncTransport, TransportState } from "../sync/transport.js";
import { DEFAULT_SETTINGS, type PluginSettings } from "../settings.js";

const deviceId = "device-1";

function memAdapter(): PluginAdapter {
  const store = new Map<string, string>();
  return {
    async exists(path) { return store.has(path); },
    async read(path) { return store.get(path) ?? ""; },
    async write(path, data) { store.set(path, data); },
    async remove(path) { store.delete(path); },
    async rename(oldPath, newPath) { const v = store.get(oldPath); if (v !== undefined) { store.set(newPath, v); store.delete(oldPath); } },
  };
}

class FakeVault implements VaultIO {
  readonly writes = new Map<string, Uint8Array>();
  listFiles(): VaultFileInfo[] { return []; }
  async readText(path: string): Promise<string> { return new TextDecoder().decode(this.writes.get(path) ?? new Uint8Array()); }
  async readBytes(path: string): Promise<Uint8Array> { return this.writes.get(path) ?? new Uint8Array(); }
  async writeText(path: string, text: string): Promise<void> { this.writes.set(path, new TextEncoder().encode(text)); }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> { this.writes.set(path, bytes); }
  async rename(): Promise<void> {}
  async trash(): Promise<void> {}
  exists(path: string): boolean { return this.writes.has(path); }
}

class FakeTransport {
  readyState: TransportState = "open";
  readonly sent: ClientMessage[] = [];
  private messageListener: ((m: ServerMessage) => void | Promise<void>) | null = null;
  private pendingContent: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void } | null = null;
  contentByHash = new Map<string, Uint8Array>();

  onMessage(listener: (m: ServerMessage) => void | Promise<void>): () => void { this.messageListener = listener; return () => { this.messageListener = null; }; }
  onState(): () => void { return () => {}; }
  connect(): void {}
  close(): void {}

  send(message: ClientMessage): void {
    this.sent.push(message);
    if (message.t === "get_content" && this.pendingContent) {
      const waiter = this.pendingContent;
      this.pendingContent = null;
      const bytes = this.contentByHash.get(message.hash) ?? null;
      const reply = { t: "content", hash: message.hash, data: bytes ? Buffer.from(bytes).toString("base64") : null } as ServerMessage;
      if (waiter.predicate(reply)) waiter.resolve(reply); else waiter.reject(new Error("predicate mismatch"));
    }
  }

  waitFor<T extends ServerMessage["t"]>(type: T, predicate: (m: Extract<ServerMessage, { t: T }>) => boolean): Promise<Extract<ServerMessage, { t: T }>> {
    if (type !== "content") return Promise.reject(new Error(`unexpected waitFor ${type}`));
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      this.pendingContent = { predicate: predicate as (m: ServerMessage) => boolean, resolve: resolve as (m: ServerMessage) => void, reject };
    });
  }

  async deliver(message: ServerMessage): Promise<void> { await this.messageListener?.(message); }
}

function makeEngine(transport: FakeTransport, vault: FakeVault) {
  const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
  const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
  const engine = new SyncEngine(settings, index, vault, transport as unknown as SyncTransport);
  return { engine, index };
}

function binaryCreateOp(fileId: string, path: string, hash: string): FileOp {
  return { opId: "op-1", deviceId: "remote", deviceSeq: 1, fileId, vaultId: "vault-1", kind: "create", type: "attachment", newPath: path, pathClock: { lamport: 1, deviceId: "remote" }, newContentVV: { remote: 1 }, contentHash: hash, blobRef: hash, size: 4 };
}

describe("SyncEngine binary blob materialization", () => {
  it("downloads and writes incoming binary content via get_content", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await contentHash(bytes);
    const transport = new FakeTransport();
    transport.contentByHash.set(hash, bytes);
    const vault = new FakeVault();
    const { engine, index } = makeEngine(transport, vault);
    engine.start();

    const applied: AppliedOp = { vaultSeq: 1, op: binaryCreateOp("file-1", "assets/img.png", hash), resultingClocks: { contentVV: { remote: 1 }, pathClock: { lamport: 1, deviceId: "remote" }, epoch: 0 } };
    await transport.deliver({ t: "ops", ops: [applied], more: false } as ServerMessage);

    expect(transport.sent.some((m) => m.t === "get_content" && m.hash === hash)).toBe(true);
    expect([...vault.writes.get("assets/img.png")!]).toEqual([1, 2, 3, 4]);
    expect(index.byFileId("file-1")?.contentHash).toBe(hash);
    expect(index.device.downloadedHashes).toContain(hash);
    expect(index.device.appliedSeq).toBe(1);
  });

  it("surfaces an error when the server cannot supply the referenced blob", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const hash = await contentHash(bytes);
    const transport = new FakeTransport();
    // contentByHash intentionally empty -> server returns data:null
    const vault = new FakeVault();
    const errors: Error[] = [];
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
    const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
    const engine = new SyncEngine(settings, index, vault, transport as unknown as SyncTransport, { onError: (e) => errors.push(e) });
    engine.start();

    const applied: AppliedOp = { vaultSeq: 1, op: binaryCreateOp("file-2", "assets/missing.png", hash), resultingClocks: { contentVV: { remote: 1 }, pathClock: { lamport: 1, deviceId: "remote" }, epoch: 0 } };
    await transport.deliver({ t: "ops", ops: [applied], more: false } as ServerMessage);

    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toMatch(/unavailable/);
    expect(vault.exists("assets/missing.png")).toBe(false);
  });
});
