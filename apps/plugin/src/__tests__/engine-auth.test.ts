import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, FileOp, ServerMessage } from "@obsidian-sync/shared";
import { SyncEngine } from "../sync/engine.js";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";
import type { VaultFileInfo, VaultIO } from "../sync/vault-io.js";
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
    async rename(oldPath, newPath) {
      const value = store.get(oldPath);
      if (value !== undefined) {
        store.set(newPath, value);
        store.delete(oldPath);
      }
    },
  };
}

class FakeVault implements VaultIO {
  listFiles(): VaultFileInfo[] { return []; }
  async readText(): Promise<string> { return "hello"; }
  async readBytes(): Promise<Uint8Array> { return new TextEncoder().encode("hello"); }
  async writeText(): Promise<void> {}
  async writeBytes(): Promise<void> {}
  async rename(): Promise<void> {}
  async trash(): Promise<void> {}
  exists(): boolean { return true; }
}

class FakeTransport {
  readyState: TransportState = "closed";
  readonly sent: ClientMessage[] = [];
  private messageListener: ((message: ServerMessage) => void | Promise<void>) | null = null;
  private stateListener: ((state: TransportState) => void) | null = null;

  onMessage(listener: (message: ServerMessage) => void | Promise<void>): () => void {
    this.messageListener = listener;
    return () => { this.messageListener = null; };
  }

  onState(listener: (state: TransportState) => void): () => void {
    this.stateListener = listener;
    return () => { this.stateListener = null; };
  }

  connect(): void {}
  close(): void {}
  send(message: ClientMessage): void { this.sent.push(message); }
  waitFor(): Promise<never> { return Promise.reject(new Error("unused")); }

  emitState(state: TransportState): void {
    this.readyState = state;
    this.stateListener?.(state);
  }

  async deliver(message: ServerMessage): Promise<void> {
    if (message.t === "welcome") this.emitState("ready");
    await this.messageListener?.(message);
  }

  latestFileOp(): FileOp | undefined {
    const message = [...this.sent].reverse().find((entry) => entry.t === "file_op");
    return message ? (message as Extract<ClientMessage, { t: "file_op" }>).op : undefined;
  }
}

describe("SyncEngine auth handshake", () => {
  it("holds outbox and Yjs sync until welcome arrives", async () => {
    const transport = new FakeTransport();
    const yjs = { handleTransportOpen: vi.fn(), handleMessage: vi.fn(async () => false) };
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
    const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
    await index.load();
    const engine = new SyncEngine(settings, index, new FakeVault(), transport as unknown as SyncTransport, {}, yjs as never);

    engine.start();
    transport.emitState("open");

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ t: "hello" });
    expect(yjs.handleTransportOpen).not.toHaveBeenCalled();

    const draft = await engine.makeContentOp("file-1", "note.md", "note", "hello");
    await engine.enqueueLocalChange(draft);

    expect(transport.latestFileOp()).toBeUndefined();

    await transport.deliver({
      t: "welcome",
      serverTime: Date.now(),
      currentSeq: 0,
      serverProtocol: 1,
      minClientProtocol: 1,
      capabilities: [],
    });

    const sent = transport.latestFileOp();
    expect(sent).toBeDefined();
    expect(sent).toMatchObject({ kind: "create", newPath: "note.md" });
    expect(yjs.handleTransportOpen).toHaveBeenCalledTimes(1);
  });

  it("waits for catch-up ops before flushing the outbox after reconnect", async () => {
    const transport = new FakeTransport();
    const yjs = { handleTransportOpen: vi.fn(), handleMessage: vi.fn(async () => false) };
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
    const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
    await index.load();
    index.setAppliedSeq(2);
    const engine = new SyncEngine(settings, index, new FakeVault(), transport as unknown as SyncTransport, {}, yjs as never);

    engine.start();
    transport.emitState("open");

    const draft = await engine.makeContentOp("file-1", "note.md", "note", "hello");
    await engine.enqueueLocalChange(draft);

    await transport.deliver({
      t: "welcome",
      serverTime: Date.now(),
      currentSeq: 4,
      serverProtocol: 1,
      minClientProtocol: 1,
      capabilities: [],
    });

    expect(transport.latestFileOp()).toBeUndefined();
    expect(yjs.handleTransportOpen).not.toHaveBeenCalled();

    await transport.deliver({
      t: "ops",
      ops: [],
      more: true,
    });
    expect(transport.latestFileOp()).toBeUndefined();

    await transport.deliver({
      t: "ops",
      ops: [],
      more: false,
    });

    expect(transport.latestFileOp()).toBeDefined();
    expect(yjs.handleTransportOpen).toHaveBeenCalledTimes(1);
  });

  it("rejects forced pushes until the handshake is ready", async () => {
    const transport = new FakeTransport();
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
    const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
    await index.load();
    const engine = new SyncEngine(settings, index, new FakeVault(), transport as unknown as SyncTransport, {});

    engine.start();
    transport.emitState("open");

    const draft = await engine.makeForcedContentOp("file-1", "note.md", "note", {}, false);
    await expect(engine.pushForced(draft)).resolves.toMatchObject({
      ok: false,
      consumed: false,
      message: "transport not connected",
    });
  });

  it("rejects forced pushes until reconnect catch-up completes after welcome", async () => {
    const transport = new FakeTransport();
    const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
    const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
    await index.load();
    index.setAppliedSeq(2);
    const engine = new SyncEngine(settings, index, new FakeVault(), transport as unknown as SyncTransport, {});

    engine.start();
    transport.emitState("open");
    await transport.deliver({
      t: "welcome",
      serverTime: Date.now(),
      currentSeq: 4,
      serverProtocol: 1,
      minClientProtocol: 1,
      capabilities: [],
    });

    const draft = await engine.makeForcedContentOp("file-1", "note.md", "note", {}, false);
    await expect(engine.pushForced(draft)).resolves.toMatchObject({
      ok: false,
      consumed: false,
      message: "transport not connected",
    });
  });
});
