import { describe, expect, it } from "vitest";
import { VaultWatcher } from "../watcher/vault-watcher.js";
import { SyncIgnore } from "../ignore/ignore.js";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";
import type { SyncEngine } from "../sync/engine.js";
import type { VaultIO, VaultFileInfo } from "../sync/vault-io.js";

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
  files = new Map<string, Uint8Array>();
  listFiles(): VaultFileInfo[] { return [...this.files.keys()].map((path) => ({ path, mtime: 1, size: this.files.get(path)!.byteLength })); }
  async readText(path: string): Promise<string> { return new TextDecoder().decode(this.files.get(path) ?? new Uint8Array()); }
  async readBytes(path: string): Promise<Uint8Array> { return this.files.get(path) ?? new Uint8Array(); }
  async writeText(path: string, text: string): Promise<void> { this.files.set(path, new TextEncoder().encode(text)); }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> { this.files.set(path, bytes); }
  async rename(): Promise<void> {}
  async trash(): Promise<void> {}
  exists(path: string): boolean { return this.files.has(path); }
}

function makeEngine() {
  const enqueued: unknown[] = [];
  const engine = {
    enqueueLocalChange: async (op: unknown) => { enqueued.push(op); return op; },
    makeContentOp: async (fileId: string, path: string, type: string) => ({ fileId, path, type, kind: "create" }),
    makeRenameOp: (fileId: string, newPath: string, type: string) => ({ fileId, newPath, type, kind: "rename" }),
    makeDeleteOp: (fileId: string, type: string) => ({ fileId, type, kind: "delete" }),
    hashPath: async () => "sha256:0",
    isRealtimeActiveFile: () => false,
    isRealtimeActivePath: () => false,
  } as unknown as SyncEngine;
  return { engine, enqueued };
}

describe("VaultWatcher suspension", () => {
  it("does not enqueue changes while suspended and resumes afterward", async () => {
    const vault = new FakeVault();
    await vault.writeText("note.md", "hello");
    const index = new LocalIndexStore(memAdapter(), "idx.json", "device-1");
    const { engine, enqueued } = makeEngine();
    const watcher = new VaultWatcher(vault, index, engine, new SyncIgnore({ common: [], local: [] }));

    watcher.suspend();
    watcher.queuePath("note.md");
    await watcher.flush();
    await watcher.handleDelete("note.md");
    await watcher.handleRename("note.md", "renamed.md");
    expect(enqueued).toHaveLength(0);

    watcher.resume();
    watcher.queuePath("note.md");
    await watcher.flush();
    expect(enqueued.length).toBeGreaterThan(0);
  });
});
