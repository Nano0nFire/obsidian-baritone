export type SyncLogLevel = "info" | "warn" | "error" | "debug";

export interface SyncLogEntry {
  id: number;
  ts: number;
  level: SyncLogLevel;
  source: string;
  message: string;
}

export interface SyncLogEntryInput {
  ts?: number;
  level: SyncLogLevel;
  source: string;
  message: string;
}

export class SyncLogStore {
  private readonly listeners = new Set<() => void>();
  private readonly entries: SyncLogEntry[] = [];
  private nextId = 1;

  constructor(private readonly limit = 500) {}

  all(): SyncLogEntry[] {
    return [...this.entries];
  }

  append(input: SyncLogEntryInput): SyncLogEntry {
    const entry: SyncLogEntry = {
      id: this.nextId++,
      ts: input.ts ?? Date.now(),
      level: input.level,
      source: input.source,
      message: input.message,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.emit();
    return entry;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries.length = 0;
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
