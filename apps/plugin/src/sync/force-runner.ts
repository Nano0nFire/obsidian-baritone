import type { FileType, ManifestEntry, VersionVector } from "@obsidian-sync/shared";
import type { LocalIndexStore } from "../localindex/index.js";
import type { VaultIO } from "./vault-io.js";
import type { FileOpDraft } from "./outbox.js";
import { planForcePush, planForcePullStrays, type LocalFileSnapshot, type RemoteFileSnapshot } from "./force-sync.js";

/** Subset of SyncEngine the runner needs (keeps the runner obsidian-free + fake-testable). */
export interface ForceEngineLike {
  hasConflicts(): boolean;
  isRealtimeActiveFile(fileId: string): boolean;
  makeForcedContentOp(fileId: string, path: string, type: FileType, dominateVV: VersionVector, remoteExists: boolean): Promise<FileOpDraft>;
  makeDeleteOp(fileId: string, type: FileType): FileOpDraft;
  pushForced(draft: FileOpDraft): Promise<{ ok: boolean; message?: string }>;
  discardUnsentOutbox(): Promise<{ discarded: number; blockedByInflight: boolean }>;
}

/** Manifest paging + per-entry materialization (satisfied by InitialSyncRunner). */
export interface ManifestSource {
  fetchManifest(): Promise<{ entries: ManifestEntry[]; watermarkSeq: number }>;
  applyManifestEntry(entry: ManifestEntry): Promise<void>;
}

export interface WatcherGate {
  suspend(): void;
  resume(): void;
}

export interface ForceRunnerOptions {
  remoteDeleteSystemTrash: boolean;
}

export type ForcePushResult =
  | { ok: true; created: number; updated: number; deleted: number; adopted: number }
  | { ok: false; blocked: "conflicts" | "realtime-active" | "rejected"; message?: string };

export type ForcePullResult =
  | { ok: true; written: number; trashed: number }
  | { ok: false; blocked: "inflight"; message?: string };

function newFileId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toRemoteSnapshots(entries: readonly ManifestEntry[]): RemoteFileSnapshot[] {
  return entries
    .filter((entry) => !entry.deleted)
    .map((entry) => ({ fileId: entry.fileId, path: entry.path, contentHash: entry.contentHash ?? null, contentVV: entry.contentVV, type: entry.type }));
}

/**
 * Orchestrates the two destructive force operations. The watcher is suspended
 * for the whole operation so locally-applied writes/deletes are not echoed
 * back, and resumed in a finally block even on failure.
 */
export class ForceSyncRunner {
  constructor(
    private readonly engine: ForceEngineLike,
    private readonly manifest: ManifestSource,
    private readonly index: LocalIndexStore,
    private readonly vault: VaultIO,
    private readonly gate: WatcherGate,
    private readonly options: ForceRunnerOptions,
  ) {}

  /** Overwrite the remote vault so it mirrors the local vault. */
  async forcePush(local: readonly LocalFileSnapshot[]): Promise<ForcePushResult> {
    if (this.engine.hasConflicts()) return { ok: false, blocked: "conflicts" };
    for (const file of local) {
      if (file.fileId && this.engine.isRealtimeActiveFile(file.fileId)) return { ok: false, blocked: "realtime-active" };
    }
    this.gate.suspend();
    try {
      const { entries } = await this.manifest.fetchManifest();
      const remote = toRemoteSnapshots(entries);
      const remoteByPath = new Map(remote.map((entry) => [entry.path, entry] as const));
      const plan = planForcePush(local, remote, newFileId);

      let adopted = 0;
      for (const adoption of plan.adoptions) {
        const match = remoteByPath.get(adoption.path);
        if (!match) continue;
        if (adoption.oldFileId) this.index.removeFileId(adoption.oldFileId);
        this.index.upsertFile({
          fileId: adoption.newFileId,
          path: adoption.path,
          type: match.type,
          contentHash: match.contentHash ?? "",
          size: 0,
          appliedContentVV: match.contentVV,
          isDir: false,
          mtime: Date.now(),
          deleted: false,
        });
        adopted += 1;
      }
      await this.index.save();

      let created = 0;
      let updated = 0;
      let deleted = 0;
      for (const action of plan.actions) {
        if (action.kind === "content") {
          const draft = await this.engine.makeForcedContentOp(action.fileId, action.path, action.type, action.dominateVV, action.mode === "update");
          const result = await this.engine.pushForced(draft);
          if (!result.ok) return { ok: false, blocked: "rejected", message: result.message };
          if (action.mode === "update") updated += 1; else created += 1;
        } else {
          const result = await this.engine.pushForced(this.engine.makeDeleteOp(action.fileId, action.type));
          if (!result.ok) return { ok: false, blocked: "rejected", message: result.message };
          deleted += 1;
        }
      }
      return { ok: true, created, updated, deleted, adopted };
    } finally {
      this.gate.resume();
    }
  }

  /**
   * Overwrite the local vault so it mirrors the remote vault. `syncablePaths`
   * MUST already be ignore-filtered (config-local/plugin-state excluded) — only
   * these paths are eligible for stray deletion.
   */
  async forcePull(syncablePaths: readonly string[]): Promise<ForcePullResult> {
    this.gate.suspend();
    try {
      const discard = await this.engine.discardUnsentOutbox();
      if (discard.blockedByInflight) return { ok: false, blocked: "inflight" };

      this.index.device.downloadedHashes = [];
      this.index.device.manifestCursor = null;
      await this.index.save();

      const { entries } = await this.manifest.fetchManifest();
      let written = 0;
      for (const entry of entries) {
        if (entry.deleted) continue;
        await this.manifest.applyManifestEntry(entry);
        written += 1;
      }

      const remote = toRemoteSnapshots(entries);
      const strays = planForcePullStrays(syncablePaths, remote);
      let trashed = 0;
      for (const path of strays) {
        if (this.vault.exists(path)) await this.vault.trash(path, this.options.remoteDeleteSystemTrash);
        const entry = this.index.byPath(path);
        if (entry) this.index.markDeleted(entry.fileId);
        trashed += 1;
      }
      await this.index.save();
      return { ok: true, written, trashed };
    } finally {
      this.gate.resume();
    }
  }
}
