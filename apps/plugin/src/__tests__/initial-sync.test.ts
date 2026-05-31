import { describe, expect, it } from "vitest";
import type { ManifestPageMessage, ServerMessage } from "@obsidian-sync/shared";
import { InitialSyncRunner } from "../sync/initial-sync.js";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";
import type { SyncTransport } from "../sync/transport.js";
import type { VaultFileInfo, VaultIO } from "../sync/vault-io.js";

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
  async readText(): Promise<string> { return ""; }
  async readBytes(): Promise<Uint8Array> { return new Uint8Array(); }
  async writeText(): Promise<void> {}
  async writeBytes(): Promise<void> {}
  async rename(): Promise<void> {}
  async trash(): Promise<void> {}
  exists(): boolean { return false; }
}

class FakeTransport {
  waitedForReady = 0;
  readonly sent: Array<{ t: string }> = [];

  async waitUntilReady(): Promise<void> {
    this.waitedForReady += 1;
  }

  waitFor<T extends ServerMessage["t"]>(_type: T): Promise<Extract<ServerMessage, { t: T }>> {
    return Promise.resolve({
      t: "manifest_page",
      watermarkSeq: 7,
      items: [],
      nextCursor: null,
    } as ManifestPageMessage as Extract<ServerMessage, { t: T }>);
  }

  send(message: { t: string }): void {
    this.sent.push(message);
  }
}

describe("InitialSyncRunner", () => {
  it("waits for transport readiness before requesting the manifest", async () => {
    const index = new LocalIndexStore(memAdapter(), "idx.json", "device-1");
    await index.load();
    const transport = new FakeTransport();
    const runner = new InitialSyncRunner(transport as unknown as SyncTransport, index, new FakeVault(), "vault-1");

    await runner.run();

    expect(transport.waitedForReady).toBe(1);
    expect(transport.sent[0]).toMatchObject({ t: "get_manifest" });
  });
});
