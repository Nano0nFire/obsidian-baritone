import { describe, expect, it } from "vitest";
import { dominates, type ClientMessage, type FileOp, type ServerMessage } from "@obsidian-sync/shared";
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
  constructor() { this.writes.set("note.md", new TextEncoder().encode("hello")); }
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
  private listener: ((m: ServerMessage) => void | Promise<void>) | null = null;
  onMessage(l: (m: ServerMessage) => void | Promise<void>): () => void { this.listener = l; return () => { this.listener = null; }; }
  onState(): () => void { return () => {}; }
  connect(): void {}
  close(): void {}
  send(message: ClientMessage): void { this.sent.push(message); }
  waitFor(): Promise<never> { return Promise.reject(new Error("unused")); }
  async deliver(message: ServerMessage): Promise<void> { await this.listener?.(message); }
  async waitForOp(): Promise<FileOp> { for (let i = 0; i < 50; i += 1) { const m = [...this.sent].reverse().find((x) => x.t === "file_op"); if (m) return (m as Extract<ClientMessage, { t: "file_op" }>).op; await new Promise((r) => setTimeout(r, 0)); } throw new Error("no file_op sent"); }
  lastOp(): FileOp { const m = [...this.sent].reverse().find((x) => x.t === "file_op") as Extract<ClientMessage, { t: "file_op" }>; return m.op; }
}

function makeEngine(transport: FakeTransport, vault: FakeVault) {
  const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
  const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
  const engine = new SyncEngine(settings, index, vault, transport as unknown as SyncTransport);
  engine.start();
  return { engine, index };
}

describe("SyncEngine force push", () => {
  it("forced content op dominates the remote contentVV and upserts index on ack", async () => {
    const transport = new FakeTransport();
    const vault = new FakeVault();
    const { engine, index } = makeEngine(transport, vault);

    const remoteVV = { remote: 5 };
    const draft = await engine.makeForcedContentOp("f1", "note.md", "note", remoteVV, true);
    expect(dominates(draft.newContentVV!, remoteVV)).toBe(true);

    const promise = engine.pushForced(draft);
    const op = await transport.waitForOp();
    expect(op.kind).toBe("update");
    await transport.deliver({ t: "op_ack", opId: op.opId, vaultSeq: 7, resultingClocks: { epoch: 0 } });
    const result = await promise;

    expect(result.ok).toBe(true);
    const entry = index.byFileId("f1");
    expect(entry?.contentHash).toBe(op.contentHash);
    expect(entry?.appliedContentVV).toEqual(op.newContentVV);
  });

  it("rolls back the deviceSeq on a terminal reject so the stream stays gap-free", async () => {
    const transport = new FakeTransport();
    const vault = new FakeVault();
    const { engine, index } = makeEngine(transport, vault);

    const draft = await engine.makeForcedContentOp("f1", "note.md", "note", {}, false);
    const promise = engine.pushForced(draft);
    const op = await transport.waitForOp();
    await transport.deliver({ t: "reject", opId: op.opId, code: "CONFLICT_PENDING", message: "blocked" });
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(index.device.nextDeviceSeq).toBe(op.deviceSeq);
    expect(index.device.outbox).toHaveLength(0);
  });
});
