import { ItemView, WorkspaceLeaf } from "obsidian";
import type { SyncLogEntry, SyncLogStore } from "./log-store.js";

export const VIEW_TYPE_LOGS = "obsidian-sync-log";

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export class SyncLogPanel extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private renderedCount = 0;
  private renderedFirstId = 0;

  constructor(leaf: WorkspaceLeaf, private readonly store: SyncLogStore) {
    super(leaf);
  }

  override getViewType(): string { return VIEW_TYPE_LOGS; }
  override getDisplayText(): string { return "Sync log"; }
  override getIcon(): string { return "list"; }

  override async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();

    const toolbar = container.createDiv({ cls: "obsidian-sync-log-toolbar" });
    toolbar.createEl("h3", { text: "Sync log" });
    const actions = toolbar.createDiv({ cls: "obsidian-sync-log-actions" });
    const clearButton = actions.createEl("button", { text: "Clear" });
    clearButton.addEventListener("click", () => this.store.clear());
    const bottomButton = actions.createEl("button", { text: "Bottom" });
    bottomButton.addEventListener("click", () => this.scrollToBottom());

    this.emptyEl = container.createEl("p", { text: "No sync log entries yet.", cls: "obsidian-sync-log-empty" });
    this.listEl = container.createDiv({ cls: "obsidian-sync-log-list" });
    this.render(true);
    this.unsubscribe = this.store.onChange(() => this.render());
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listEl = null;
    this.emptyEl = null;
    this.renderedCount = 0;
    this.renderedFirstId = 0;
  }

  private render(forceReset = false): void {
    if (!this.listEl || !this.emptyEl) return;
    const entries = this.store.all();
    const wasNearBottom = this.isNearBottom();
    const firstId = entries[0]?.id ?? 0;
    const needsReset = forceReset || entries.length === 0 || this.renderedCount === 0 || entries.length < this.renderedCount || firstId !== this.renderedFirstId;

    this.emptyEl.toggleClass("is-hidden", entries.length > 0);

    if (entries.length === 0) {
      this.listEl.empty();
      this.renderedCount = 0;
      this.renderedFirstId = 0;
      return;
    }

    if (needsReset) {
      this.listEl.empty();
      for (const entry of entries) this.listEl.appendChild(this.renderEntry(entry));
      this.renderedCount = entries.length;
      this.renderedFirstId = firstId;
    } else if (entries.length > this.renderedCount) {
      for (const entry of entries.slice(this.renderedCount)) this.listEl.appendChild(this.renderEntry(entry));
      this.renderedCount = entries.length;
    }

    if (wasNearBottom || forceReset) this.scrollToBottom();
  }

  private renderEntry(entry: SyncLogEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = `obsidian-sync-log-entry is-${entry.level}`;

    const meta = document.createElement("div");
    meta.className = "obsidian-sync-log-meta";
    meta.createEl("span", { text: formatTimestamp(entry.ts), cls: "obsidian-sync-log-time" });
    meta.createEl("span", { text: entry.level.toUpperCase(), cls: `obsidian-sync-log-level is-${entry.level}` });
    meta.createEl("span", { text: entry.source, cls: "obsidian-sync-log-source" });

    const message = document.createElement("div");
    message.className = "obsidian-sync-log-message";
    message.textContent = entry.message;

    row.append(meta, message);
    return row;
  }

  private isNearBottom(): boolean {
    if (!this.listEl) return true;
    return this.listEl.scrollTop + this.listEl.clientHeight >= this.listEl.scrollHeight - 24;
  }

  private scrollToBottom(): void {
    if (!this.listEl) return;
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}
