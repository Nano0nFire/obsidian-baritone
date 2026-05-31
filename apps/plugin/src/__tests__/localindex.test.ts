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
});
