import type { ConflictRecord } from "@obsidian-sync/shared";

export class ConflictStore {
  private readonly records = new Map<string, ConflictRecord>();
  private readonly listeners = new Set<() => void>();

  all(): ConflictRecord[] { return [...this.records.values()].sort((a, b) => a.conflictId.localeCompare(b.conflictId)); }
  get(id: string): ConflictRecord | undefined { return this.records.get(id); }
  upsert(record: ConflictRecord): void { this.records.set(record.conflictId, record); this.emit(); }
  remove(id: string): void { this.records.delete(id); this.emit(); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }
}
