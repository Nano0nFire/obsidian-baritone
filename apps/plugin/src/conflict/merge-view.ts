import { App, Modal, Notice, Setting } from "obsidian";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { bump, join, type ConflictRecord, type VersionVector } from "@obsidian-sync/shared";
import type { SyncTransport } from "../sync/transport.js";

export class ManualChoiceModal extends Modal {
  constructor(app: App, private readonly titleText: string, private readonly choices: Array<{ label: string; action: () => void }>) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.titleText });
    for (const choice of this.choices) new Setting(this.contentEl).setName(choice.label).addButton((button) => button.setButtonText("Choose").onClick(() => { choice.action(); this.close(); }));
  }
}

export class TextMergeModal extends Modal {
  private merge: MergeView | null = null;
  constructor(
    app: App,
    private readonly conflict: ConflictRecord,
    private readonly baseText: string,
    private readonly oursText: string,
    private readonly theirsText: string,
    private readonly deviceId: string,
    private readonly transport: SyncTransport,
  ) { super(app); }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("obsidian-sync-merge-modal");
    this.contentEl.createEl("h2", { text: `Resolve conflict ${this.conflict.conflictId}` });
    this.contentEl.createEl("p", { text: "Base is shown for reference. Edit the right pane until it contains the resolved content, then resolve." });
    const base = this.contentEl.createEl("textarea", { cls: "obsidian-sync-base", text: this.baseText });
    base.readOnly = true;
    const host = this.contentEl.createDiv({ cls: "obsidian-sync-merge-host" });
    this.merge = new MergeView({
      a: { doc: this.oursText, extensions: [EditorState.readOnly.of(true)] },
      b: { doc: this.theirsText },
      parent: host,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Resolve with right pane").setCta().onClick(() => this.resolve(this.merge?.b.state.doc.toString() ?? this.theirsText)))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  override onClose(): void { this.merge?.destroy(); this.merge = null; this.contentEl.empty(); }

  private resolve(text: string): void {
    const vv = conflictResolvedVV(this.conflict.oursVV ?? {}, this.conflict.theirsVV ?? {}, this.deviceId);
    this.transport.send({ t: "resolve_conflict", conflictId: this.conflict.conflictId, inlineText: text, resolvedVV: vv });
    new Notice("Conflict resolution sent");
    this.close();
  }
}

export function conflictResolvedVV(ours: VersionVector, theirs: VersionVector, deviceId: string): VersionVector {
  return bump(join(ours, theirs), deviceId);
}
