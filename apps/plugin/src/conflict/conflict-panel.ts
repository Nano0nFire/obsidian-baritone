import { ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type { ConflictRecord } from "@obsidian-sync/shared";
import type { ConflictStore } from "./conflict-store.js";
import type { SyncTransport } from "../sync/transport.js";

export const VIEW_TYPE_CONFLICTS = "obsidian-sync-conflicts";

export class ConflictPanel extends ItemView {
  private unsubscribe: (() => void) | null = null;
  constructor(leaf: WorkspaceLeaf, private readonly store: ConflictStore, private readonly transport: SyncTransport, private readonly onOpenMerge: (conflict: ConflictRecord) => void) {
    super(leaf);
  }
  override getViewType(): string { return VIEW_TYPE_CONFLICTS; }
  override getDisplayText(): string { return "Sync conflicts"; }
  override getIcon(): string { return "git-compare"; }

  override async onOpen(): Promise<void> {
    this.unsubscribe = this.store.onChange(() => this.render());
    this.render();
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.createEl("h3", { text: "Unresolved conflicts" });
    const records = this.store.all().filter((record) => record.status !== "resolved");
    if (records.length === 0) {
      container.createEl("p", { text: "No unresolved conflicts." });
      return;
    }
    for (const conflict of records) this.renderConflict(container, conflict);
  }

  private renderConflict(container: HTMLElement, conflict: ConflictRecord): void {
    const box = container.createDiv({ cls: "obsidian-sync-conflict" });
    box.createEl("strong", { text: `${conflict.kind} conflict` });
    box.createEl("div", { text: `File: ${conflict.fileId}` });
    box.createEl("span", { text: conflict.status, cls: `obsidian-sync-badge is-${conflict.status}` });
    new Setting(box)
      .addButton((button) => button.setButtonText("Claim").onClick(() => { this.transport.send({ t: "claim_conflict", conflictId: conflict.conflictId }); new Notice("Claim requested"); }))
      .addButton((button) => button.setButtonText("Open merge").setCta().onClick(() => this.onOpenMerge(conflict)))
      .addButton((button) => button.setButtonText("Release").onClick(() => this.transport.send({ t: "release_conflict", conflictId: conflict.conflictId })));
  }
}
