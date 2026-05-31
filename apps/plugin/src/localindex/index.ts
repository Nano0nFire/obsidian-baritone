import { caseFoldPath, type VersionVector, type FileType, type PathClock } from "@obsidian-sync/shared";
import type { OutboxEntry } from "../sync/outbox.js";

export interface FileIndexEntry {
  fileId: string;
  path: string;
  pathNormalized: string;
  type: FileType;
  contentHash: string | null;
  size: number;
  appliedContentVV: VersionVector;
  pathClock?: PathClock;
  isDir: boolean;
  mtime: number;
  deleted?: boolean;
}

export interface DeviceState {
  appliedSeq: number;
  deviceId: string;
  nextDeviceSeq: number;
  outbox: OutboxEntry[];
  manifestCursor?: string | null;
  manifestWatermarkSeq?: number;
  downloadedHashes: string[];
}

export interface LocalIndexSnapshot {
  schemaVersion: 1;
  files: FileIndexEntry[];
  device: DeviceState;
  conflicts: string[];
}

export interface PluginAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove?(path: string): Promise<void>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
}

function defaultSnapshot(deviceId: string): LocalIndexSnapshot {
  return {
    schemaVersion: 1,
    files: [],
    device: { appliedSeq: 0, deviceId, nextDeviceSeq: 1, outbox: [], downloadedHashes: [] },
    conflicts: [],
  };
}

export class LocalIndexStore {
  private snapshot: LocalIndexSnapshot;

  constructor(private readonly adapter: PluginAdapter, private readonly path: string, deviceId: string) {
    this.snapshot = defaultSnapshot(deviceId);
  }

  get data(): LocalIndexSnapshot { return this.snapshot; }
  get files(): FileIndexEntry[] { return this.snapshot.files; }
  get device(): DeviceState { return this.snapshot.device; }

  async load(): Promise<LocalIndexSnapshot> {
    if (!(await this.adapter.exists(this.path))) return this.snapshot;
    const raw = await this.adapter.read(this.path);
    const parsed = JSON.parse(raw) as Partial<LocalIndexSnapshot>;
    if (parsed.schemaVersion !== 1 || !parsed.device || !Array.isArray(parsed.files)) {
      throw new Error("Unsupported local index schema");
    }
    this.snapshot = {
      schemaVersion: 1,
      files: parsed.files.map((entry) => ({ ...entry, pathNormalized: entry.pathNormalized ?? caseFoldPath(entry.path) } as FileIndexEntry)),
      device: {
        appliedSeq: parsed.device.appliedSeq ?? 0,
        deviceId: parsed.device.deviceId,
        nextDeviceSeq: parsed.device.nextDeviceSeq ?? 1,
        outbox: parsed.device.outbox ?? [],
        manifestCursor: parsed.device.manifestCursor,
        manifestWatermarkSeq: parsed.device.manifestWatermarkSeq,
        downloadedHashes: parsed.device.downloadedHashes ?? [],
      },
      conflicts: parsed.conflicts ?? [],
    };
    return this.snapshot;
  }

  async save(): Promise<void> {
    const tmp = `${this.path}.next`;
    const text = `${JSON.stringify(this.snapshot, null, 2)}\n`;
    await this.adapter.write(tmp, text);
    if (this.adapter.rename) {
      await this.adapter.rename(tmp, this.path);
    } else {
      await this.adapter.write(this.path, text);
      if (this.adapter.remove) await this.adapter.remove(tmp);
    }
  }

  upsertFile(entry: Omit<FileIndexEntry, "pathNormalized"> & Partial<Pick<FileIndexEntry, "pathNormalized">>): void {
    const next: FileIndexEntry = { ...entry, pathNormalized: entry.pathNormalized ?? caseFoldPath(entry.path) };
    const idx = this.snapshot.files.findIndex((item) => item.fileId === next.fileId);
    if (idx >= 0) this.snapshot.files[idx] = next;
    else this.snapshot.files.push(next);
  }

  byPath(path: string): FileIndexEntry | undefined { return this.snapshot.files.find((entry) => entry.path === path && !entry.deleted); }
  byFileId(fileId: string): FileIndexEntry | undefined { return this.snapshot.files.find((entry) => entry.fileId === fileId); }

  markDeleted(fileId: string): void {
    const entry = this.byFileId(fileId);
    if (entry) entry.deleted = true;
  }

  removeFileId(fileId: string): void {
    this.snapshot.files = this.snapshot.files.filter((entry) => entry.fileId !== fileId);
  }

  setAppliedSeq(seq: number): void { this.snapshot.device.appliedSeq = Math.max(this.snapshot.device.appliedSeq, seq); }
  setOutbox(outbox: OutboxEntry[], nextDeviceSeq: number): void {
    this.snapshot.device.outbox = outbox;
    this.snapshot.device.nextDeviceSeq = nextDeviceSeq;
  }
  addConflict(conflictId: string): void {
    if (!this.snapshot.conflicts.includes(conflictId)) this.snapshot.conflicts.push(conflictId);
  }
  removeConflict(conflictId: string): void {
    this.snapshot.conflicts = this.snapshot.conflicts.filter((id) => id !== conflictId);
  }
}
