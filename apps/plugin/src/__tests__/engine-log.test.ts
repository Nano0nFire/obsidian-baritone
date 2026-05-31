import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, FileOp, ServerMessage } from "@obsidian-sync/shared";
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
    async rename(oldPath, newPath) { const value = store.get(oldPath); if (value !== undefined) { store.set(newPath, value); store.delete(oldPath); } },
  };
}

class FakeVault implements VaultIO {
  listFiles(): VaultFileInfo[] { return []; }
  async readText(): Promise<string> { return ""; }
  async readBytes(): Promise<Uint8Array> { return new Uint8Array(); }
  async writeText(): Promise<void> {}
  async writeBytes(): Promise<void> {}
  async rename(): Promise<void> {}
  async trash(): Promise<void> {}
  exists(): boolean { return false; }
}

class FakeTransport {
  readyState: TransportState = "closed";
  readonly sent: ClientMessage[] = [];
  private listener: ((message: ServerMessage) => void | Promise<void>) | null = null;
  private stateListener: ((state: TransportState) => void) | null = null;
  onMessage(listener: (message: ServerMessage) => void | Promise<void>): () => void { this.listener = listener; return () => { this.listener = null; }; }
  onState(listener: (state: TransportState) => void): () => void { this.stateListener = listener; return () => { this.stateListener = null; }; }
  connect(): void {
    this.readyState = "open";
    this.stateListener?.("open");
  }
  close(): void {}
  send(message: ClientMessage): void { this.sent.push(message); }
  waitFor(): Promise<never> { return Promise.reject(new Error("unused")); }
  async deliver(message: ServerMessage): Promise<void> { await this.listener?.(message); }
  async sendServer(message: ServerMessage): Promise<void> {
    if (message.t === "welcome") {
      this.readyState = "ready";
      this.stateListener?.("ready");
    }
    await this.deliver(message);
  }
  async waitForOp(): Promise<FileOp> {
    for (let i = 0; i < 50; i += 1) {
      const message = [...this.sent].reverse().find((entry) => entry.t === "file_op");
      if (message) return (message as Extract<ClientMessage, { t: "file_op" }>).op;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("no file_op sent");
  }
}

async function makeEngine(transport: FakeTransport, onReject: ReturnType<typeof vi.fn>) {
  const settings: PluginSettings = { ...DEFAULT_SETTINGS, deviceId, vaultId: "vault-1", accessToken: "token", paused: false };
  const index = new LocalIndexStore(memAdapter(), "idx.json", deviceId);
  await index.load();
  const engine = new SyncEngine(settings, index, new FakeVault(), transport as unknown as SyncTransport, { onReject });
  engine.start();
  await transport.sendServer({
    t: "welcome",
    serverTime: Date.now(),
    currentSeq: 0,
    serverProtocol: 1,
    minClientProtocol: 1,
    capabilities: [],
  });
  return engine;
}

describe("SyncEngine reject logging hook", () => {
  it("emits onReject when the server rejects an outbox op", async () => {
    const transport = new FakeTransport();
    const onReject = vi.fn();
    const engine = await makeEngine(transport, onReject);

    const draft = await engine.makeContentOp("f1", "note.md", "note", "hello");
    await engine.enqueueLocalChange(draft);
    const op = await transport.waitForOp();
    await transport.deliver({ t: "reject", opId: op.opId, code: "STALE", message: "server rejected op" });

    expect(onReject).toHaveBeenCalledWith(op.opId, "STALE", "server rejected op");
  });
});
