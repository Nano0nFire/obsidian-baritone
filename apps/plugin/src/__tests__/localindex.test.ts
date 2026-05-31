import { describe, expect, it } from "vitest";
import { LocalIndexStore, type PluginAdapter } from "../localindex/index.js";

class RenameNoOverwriteAdapter implements PluginAdapter {
  files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (this.files.has(newPath)) throw new Error("Destination file already exist");
    const value = this.files.get(oldPath);
    if (value === undefined) throw new Error(`missing: ${oldPath}`);
    this.files.set(newPath, value);
    this.files.delete(oldPath);
  }
}

class RenameDeletesTempBeforeThrowingAdapter extends RenameNoOverwriteAdapter {
  override async remove(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    this.files.delete(path);
  }

  override async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(oldPath);
    if (value === undefined) throw new Error(`missing: ${oldPath}`);
    this.files.delete(oldPath);
    if (this.files.has(newPath)) throw new Error("Destination file already exist");
    this.files.set(newPath, value);
  }
}

describe("LocalIndexStore.save", () => {
  it("falls back when adapter rename cannot overwrite an existing state file", async () => {
    const adapter = new RenameNoOverwriteAdapter();
    adapter.files.set("state.json", JSON.stringify({
      schemaVersion: 1,
      files: [],
      device: { appliedSeq: 3, deviceId: "device-1", nextDeviceSeq: 4, outbox: [], downloadedHashes: [] },
      conflicts: [],
    }));

    const store = new LocalIndexStore(adapter, "state.json", "device-1");
    await store.load();
    store.setAppliedSeq(9);

    await store.save();

    expect(JSON.parse(adapter.files.get("state.json") ?? "{}")).toMatchObject({
      device: { appliedSeq: 9, deviceId: "device-1" },
    });
    expect(adapter.files.has("state.json.next")).toBe(false);
  });

  it("ignores missing temp-file cleanup when rename already removed the temp path", async () => {
    const adapter = new RenameDeletesTempBeforeThrowingAdapter();
    adapter.files.set("state.json", JSON.stringify({
      schemaVersion: 1,
      files: [],
      device: { appliedSeq: 3, deviceId: "device-1", nextDeviceSeq: 4, outbox: [], downloadedHashes: [] },
      conflicts: [],
    }));

    const store = new LocalIndexStore(adapter, "state.json", "device-1");
    await store.load();
    store.setAppliedSeq(11);

    await expect(store.save()).resolves.toBeUndefined();

    expect(JSON.parse(adapter.files.get("state.json") ?? "{}")).toMatchObject({
      device: { appliedSeq: 11, deviceId: "device-1" },
    });
    expect(adapter.files.has("state.json.next")).toBe(false);
  });
});

describe("LocalIndexStore.resetSessionState", () => {
  it("resets only device-scoped sync state when the device identity changes within the same vault", async () => {
    const adapter = new RenameNoOverwriteAdapter();
    adapter.files.set("state.json", JSON.stringify({
      schemaVersion: 1,
      files: [{
        fileId: "file-1",
        path: "note.md",
        pathNormalized: "note.md",
        type: "text",
        contentHash: "abc",
        size: 10,
        appliedContentVV: { "device-1": 4 },
        isDir: false,
        mtime: 100,
      }],
      device: {
        appliedSeq: 9,
        deviceId: "device-1",
        vaultId: "vault-1",
        nextDeviceSeq: 12,
        outbox: [{ op: { t: "upsert_file", opId: "op-1", deviceId: "device-1", deviceSeq: 11, fileId: "file-1", path: "note.md", type: "text", baseContentHash: null, contentHash: "abc", size: 10, vv: { "device-1": 4 } }, attempts: 1, inflight: true }],
        manifestCursor: "cursor-1",
        manifestWatermarkSeq: 9,
        downloadedHashes: ["abc"],
      },
      conflicts: ["conflict-1"],
    }));

    const store = new LocalIndexStore(adapter, "state.json", "device-1", "vault-1");
    await store.load();

    store.resetSessionState("device-2", "vault-1");

    expect(store.files).toHaveLength(1);
    expect(store.data.conflicts).toEqual(["conflict-1"]);
    expect(store.device).toMatchObject({
      deviceId: "device-2",
      vaultId: "vault-1",
      appliedSeq: 0,
      nextDeviceSeq: 1,
      outbox: [],
      manifestCursor: null,
      manifestWatermarkSeq: null,
      downloadedHashes: [],
    });
  });

  it("clears all persisted sync state when the vault changes", async () => {
    const adapter = new RenameNoOverwriteAdapter();
    const store = new LocalIndexStore(adapter, "state.json", "device-1", "vault-1");

    store.upsertFile({
      fileId: "file-1",
      path: "note.md",
      type: "note",
      contentHash: "abc",
      size: 10,
      appliedContentVV: { "device-1": 4 },
      isDir: false,
      mtime: 100,
    });
    store.setAppliedSeq(9);
    store.addConflict("conflict-1");

    store.resetSessionState("device-1", "vault-2");

    expect(store.files).toHaveLength(0);
    expect(store.data.conflicts).toEqual([]);
    expect(store.device).toMatchObject({
      deviceId: "device-1",
      vaultId: "vault-2",
      appliedSeq: 0,
      nextDeviceSeq: 1,
      outbox: [],
    });
  });
});
