import type { SnapshotVersionMetadata } from '@obsidian-sync/shared';
import type { Logger } from '../log/logger.js';
import type { YjsRoomStore } from './yjs.js';

export interface GcSnapshotRow extends SnapshotVersionMetadata {
  vaultId: string;
  isCurrent: boolean;
}

export interface YjsGcResult {
  historyPruned: number;
  snapshotsPruned: number;
  updatesPruned: number;
}

export function selectYjsHistoryRetention(rows: GcSnapshotRow[], retainedPerFile: number): { keepVersionIds: string[]; pruneVersionIds: string[] } {
  const grouped = new Map<string, GcSnapshotRow[]>();
  for (const row of rows) {
    const key = `${row.vaultId}:${row.fileId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const keep = new Set<string>();
  const prune: string[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq || b.versionId.localeCompare(a.versionId));
    for (const row of group.filter((r) => r.isCurrent)) keep.add(row.versionId);
    let retained = 0;
    for (const row of group) {
      if (keep.has(row.versionId)) continue;
      if (retained < retainedPerFile) {
        keep.add(row.versionId);
        retained += 1;
      } else prune.push(row.versionId);
    }
  }
  return { keepVersionIds: [...keep], pruneVersionIds: prune };
}

export class YjsGcJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly store: YjsRoomStore,
    private readonly options: { retainedVersionsPerFile: number; intervalMs: number; logger?: Logger },
  ) {}

  start(): void {
    if (this.timer || this.options.intervalMs <= 0) return;
    this.schedule();
  }

  async runOnce(): Promise<YjsGcResult> {
    if (this.running) return { historyPruned: 0, snapshotsPruned: 0, updatesPruned: 0 };
    this.running = true;
    try {
      const rows = await this.store.listSnapshotHistoryForGc();
      const plan = selectYjsHistoryRetention(rows, this.options.retainedVersionsPerFile);
      const historyPruned = await this.store.pruneSnapshotHistory(plan.pruneVersionIds);
      const compacted = await this.store.pruneSupersededYjsData?.() ?? { snapshots: 0, updates: 0 };
      this.options.logger?.debug('yjs gc completed', { event: 'yjs_gc_completed', historyPruned, snapshotsPruned: compacted.snapshots, updatesPruned: compacted.updates });
      return { historyPruned, snapshotsPruned: compacted.snapshots, updatesPruned: compacted.updates };
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().catch((error) => this.options.logger?.error('yjs gc failed', { event: 'yjs_gc_failed', error })).finally(() => this.schedule());
    }, this.options.intervalMs);
    this.timer.unref?.();
  }
}
