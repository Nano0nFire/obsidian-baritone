import { describe, expect, it } from "vitest";
import type { ManifestEntry } from "@obsidian-sync/shared";
import { ForceSyncRunner, type ForceEngineLike, type ManifestSource, type WatcherGate } from "../sync/force-runner.js";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";
import type { VaultIO, VaultFileInfo } from "../sync/vault-io.js";
import type { FileOpDraft } from "../sync/outbox.js";

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
  trashed: { path: string; system: boolean }[] = [];
  listFiles(): VaultFileInfo[] { return [...this.files.keys()].map((path) => ({ path, mtime: 1, size: this.files.get(path)!.byteLength })); }
  async readText(path: string): Promise<string> { return new TextDecoder().decode(this.files.get(path) ?? new Uint8Array()); }
  async readBytes(path: string): Promise<Uint8Array> { return this.files.get(path) ?? new Uint8Array(); }
  async writeText(path: string, text: string): Promise<void> { this.files.set(path, new TextEncoder().encode(text)); }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> { this.files.set(path, bytes); }
  async rename(): Promise<void> {}
  async trash(path: string, system: boolean): Promise<void> { this.trashed.push({ path, system }); this.files.delete(path); }
  exists(path: string): boolean { return this.files.has(path); }
}

class FakeEngine implements ForceEngineLike {
  pushed: FileOpDraft[] = [];
  conflicts = false;
  active = new Set<string>();
  rejectFor: string | null = null;
  hasConflicts(): boolean { return this.conflicts; }
  isRealtimeActiveFile(fileId: string): boolean { return this.active.has(fileId); }
  async makeForcedContentOp(fileId: string, path: string, type: string, dominateVV: Record<string, number>, remoteExists: boolean): Promise<FileOpDraft> {
    return { vaultId: "v", fileId, kind: remoteExists ? "update" : "create", type: type as ManifestEntry["type"], newPath: path, newContentVV: dominateVV, contentHash: "sha256:local-" + path } as FileOpDraft;
  }
  makeDeleteOp(fileId: string, type: string): FileOpDraft { return { vaultId: "v", fileId, kind: "delete", type: type as ManifestEntry["type"] } as FileOpDraft; }
  async pushForced(draft: FileOpDraft): Promise<{ ok: boolean; message?: string }> {
    this.pushed.push(draft);
    if (this.rejectFor && draft.fileId === this.rejectFor) return { ok: false, message: "rejected" };
    return { ok: true };
  }
  async discardUnsentOutbox(): Promise<{ discarded: number; blockedByInflight: boolean }> { return { discarded: 0, blockedByInflight: false }; }
}

class FakeManifest implements ManifestSource {
  constructor(private readonly entries: ManifestEntry[]) {}
  applied: ManifestEntry[] = [];
  async fetchManifest(): Promise<{ entries: ManifestEntry[]; watermarkSeq: number }> { return { entries: this.entries, watermarkSeq: 42 }; }
  async applyManifestEntry(entry: ManifestEntry): Promise<void> { this.applied.push(entry); }
}

function gate(): WatcherGate & { calls: string[] } {
  const calls: string[] = [];
  return { calls, suspend() { calls.push("suspend"); }, resume() { calls.push("resume"); } };
}

function manifestEntry(over: Partial<ManifestEntry> & Pick<ManifestEntry, "fileId" | "path">): ManifestEntry {
  return { type: "note", contentHash: "sha256:remote", contentVV: { remote: 1 }, pathClock: { lamport: 1, deviceId: "remote" }, epoch: 0, size: 1, deleted: false, ...over } as ManifestEntry;
}

function makeIndex() { return new LocalIndexStore(memAdapter(), "idx.json", "device-1"); }

describe("ForceSyncRunner.forcePush", () => {
  it("blocks when there are unresolved conflicts", async () => {
    const engine = new FakeEngine();
    engine.conflicts = true;
    const runner = new ForceSyncRunner(engine, new FakeManifest([]), makeIndex(), new FakeVault(), gate(), { remoteDeleteSystemTrash: false });
    const result = await runner.forcePush([{ path: "a.md", hash: "h", type: "note", fileId: "f1" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected block");
    expect(result.blocked).toBe("conflicts");
    expect(engine.pushed).toHaveLength(0);
  });

  it("blocks when a target file is in a realtime session", async () => {
    const engine = new FakeEngine();
    engine.active.add("f1");
    const runner = new ForceSyncRunner(engine, new FakeManifest([]), makeIndex(), new FakeVault(), gate(), { remoteDeleteSystemTrash: false });
    const result = await runner.forcePush([{ path: "a.md", hash: "h", type: "note", fileId: "f1" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected block");
    expect(result.blocked).toBe("realtime-active");
  });

  it("creates new, updates changed, deletes remote-only, and resumes the watcher", async () => {
    const engine = new FakeEngine();
    const g = gate();
    const remote = [
      manifestEntry({ fileId: "f-same", path: "same.md", contentHash: "sha256:x" }),
      manifestEntry({ fileId: "f-changed", path: "changed.md", contentHash: "sha256:old", contentVV: { remote: 3 } }),
      manifestEntry({ fileId: "f-stray", path: "stray.md" }),
    ];
    const runner = new ForceSyncRunner(engine, new FakeManifest(remote), makeIndex(), new FakeVault(), g, { remoteDeleteSystemTrash: false });
    const result = await runner.forcePush([
      { path: "same.md", hash: "sha256:x", type: "note", fileId: "f-same" },
      { path: "changed.md", hash: "sha256:new", type: "note", fileId: "f-changed" },
      { path: "fresh.md", hash: "sha256:fresh", type: "note" },
    ]);
    expect(result.ok).toBe(true);
    const kinds = engine.pushed.map((d) => `${d.kind}:${d.fileId}`);
    expect(kinds).toContain("update:f-changed");
    expect(kinds).toContain("create:fresh.md".replace("fresh.md", engine.pushed.find((d) => d.kind === "create")!.fileId));
    expect(kinds).toContain("delete:f-stray");
    expect(kinds).not.toContain("update:f-same");
    expect(g.calls).toEqual(["suspend", "resume"]);
  });

  it("stops and resumes on a terminal reject", async () => {
    const engine = new FakeEngine();
    engine.rejectFor = "f-changed";
    const g = gate();
    const remote = [manifestEntry({ fileId: "f-changed", path: "changed.md", contentHash: "sha256:old" })];
    const runner = new ForceSyncRunner(engine, new FakeManifest(remote), makeIndex(), new FakeVault(), g, { remoteDeleteSystemTrash: false });
    const result = await runner.forcePush([{ path: "changed.md", hash: "sha256:new", type: "note", fileId: "f-changed" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected block");
    expect(result.blocked).toBe("rejected");
    expect(g.calls).toEqual(["suspend", "resume"]);
  });
});

describe("ForceSyncRunner.forcePull", () => {
  it("overwrites from manifest and trashes scoped strays honoring delete target", async () => {
    const engine = new FakeEngine();
    const g = gate();
    const vault = new FakeVault();
    await vault.writeText("keep.md", "old");
    await vault.writeText("stray.md", "gone");
    const index = makeIndex();
    index.upsertFile({ fileId: "f-stray", path: "stray.md", type: "note", contentHash: "h", size: 1, appliedContentVV: {}, isDir: false, mtime: 1, deleted: false });
    index.device.downloadedHashes = ["sha256:cached"];
    const remote = [manifestEntry({ fileId: "f-keep", path: "keep.md", contentHash: "sha256:keep" })];
    const runner = new ForceSyncRunner(engine, new FakeManifest(remote), index, vault, g, { remoteDeleteSystemTrash: true });

    const result = await runner.forcePull(["keep.md", "stray.md"]);

    expect(result.ok).toBe(true);
    expect(index.device.downloadedHashes).toEqual([]);
    expect(vault.trashed).toEqual([{ path: "stray.md", system: true }]);
    expect(index.byFileId("f-stray")?.deleted).toBe(true);
    expect(g.calls).toEqual(["suspend", "resume"]);
  });

  it("blocks when unsent ops cannot be safely discarded", async () => {
    const engine = new FakeEngine();
    engine.discardUnsentOutbox = async () => ({ discarded: 0, blockedByInflight: true });
    const g = gate();
    const runner = new ForceSyncRunner(engine, new FakeManifest([]), makeIndex(), new FakeVault(), g, { remoteDeleteSystemTrash: false });
    const result = await runner.forcePull([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected block");
    expect(result.blocked).toBe("inflight");
    expect(g.calls).toEqual(["suspend", "resume"]);
  });
});
