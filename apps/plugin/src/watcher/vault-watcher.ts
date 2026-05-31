import { type FileType } from "@obsidian-sync/shared";
import { canonicalVaultPath, isTextPath } from "../pathing.js";
import type { SyncIgnore } from "../ignore/ignore.js";
import type { LocalIndexStore } from "../localindex/index.js";
import type { SyncEngine } from "../sync/engine.js";
import type { VaultFileInfo, VaultIO } from "../sync/vault-io.js";
import { planReconciliation } from "./reconciliation.js";

function newFileId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function classify(path: string): FileType {
  if (path.startsWith(".obsidian/")) return "config";
  return isTextPath(path) ? "note" : "attachment";
}

export class VaultWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued = new Set<string>();
  private suspended = false;

  constructor(private readonly vault: VaultIO, private readonly index: LocalIndexStore, private readonly engine: SyncEngine, private readonly ignore: SyncIgnore) {}

  /** Stop reacting to vault events. Used around destructive force operations so
   * locally-applied remote writes/deletes are not echoed back to the server. */
  suspend(): void {
    this.suspended = true;
    this.queued.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resume(): void { this.suspended = false; }

  get isSuspended(): boolean { return this.suspended; }

  queuePath(path: string): void {
    if (this.suspended) return;
    try {
      const canonical = canonicalVaultPath(path);
      if (this.ignore.ignores(canonical) || this.engine.isRealtimeActivePath(canonical)) return;
      this.queued.add(canonical);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), 750);
    } catch {
      return;
    }
  }

  async flush(): Promise<void> {
    if (this.suspended) return;
    const paths = [...this.queued];
    this.queued.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const path of paths) await this.syncPath(path);
  }

  async reconcile(): Promise<void> {
    if (this.suspended) return;
    const disk = await Promise.all(this.vault.listFiles()
      .map((file) => file.path)
      .filter((path) => !this.ignore.ignores(path))
      .map(async (path) => ({ path, contentHash: await this.hashPath(path), mtime: this.fileInfo(path)?.mtime ?? Date.now(), size: this.fileInfo(path)?.size ?? 0 })));
    const plan = planReconciliation({ indexed: this.index.files.filter((entry) => !entry.deleted), disk });
    for (const rename of plan.renames) await this.engine.enqueueLocalChange(this.engine.makeRenameOp(rename.fileId, rename.newPath, classify(rename.newPath)));
    for (const item of plan.creates) await this.syncPath(item.path);
    for (const item of plan.updates) await this.syncPath(item.disk.path);
    for (const item of plan.deletes) {
      if (this.engine.isRealtimeActiveFile(item.fileId)) continue;
      const entry = this.index.byFileId(item.fileId);
      await this.engine.enqueueLocalChange(this.engine.makeDeleteOp(item.fileId, entry?.type ?? "note"));
    }
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    if (this.suspended) return;
    const oldCanonical = canonicalVaultPath(oldPath);
    const newCanonical = canonicalVaultPath(newPath);
    if (this.ignore.ignores(newCanonical)) return;
    const entry = this.index.byPath(oldCanonical);
    if (!entry) return this.syncPath(newCanonical);
    if (this.engine.isRealtimeActiveFile(entry.fileId)) return;
    await this.engine.enqueueLocalChange(this.engine.makeRenameOp(entry.fileId, newCanonical, entry.type));
  }

  async handleDelete(path: string): Promise<void> {
    if (this.suspended) return;
    const entry = this.index.byPath(canonicalVaultPath(path));
    if (!entry || this.engine.isRealtimeActiveFile(entry.fileId)) return;
    await this.engine.enqueueLocalChange(this.engine.makeDeleteOp(entry.fileId, entry.type));
  }

  private async syncPath(path: string): Promise<void> {
    if (this.ignore.ignores(path) || !this.vault.exists(path)) return;
    const entry = this.index.byPath(path);
    if (entry && this.engine.isRealtimeActiveFile(entry.fileId)) return;
    const fileId = entry?.fileId ?? newFileId();
    const type = entry?.type ?? classify(path);
    const draft = await this.engine.makeContentOp(fileId, path, type);
    await this.engine.enqueueLocalChange(draft);
  }

  private async hashPath(path: string): Promise<string> {
    return this.engine.hashPath(path);
  }

  private fileInfo(path: string): VaultFileInfo | undefined {
    return this.vault.listFiles().find((file) => file.path === path);
  }
}
