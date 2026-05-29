import { Notice, Plugin, TFile, type DataAdapter } from "obsidian";
import { DEFAULT_SETTINGS, ensureDeviceId, parseIgnoreLines, type PluginSettings } from "./settings.js";
import { ObsidianSyncSettingTab } from "./settings-tab.js";
import { LocalIndexStore, type PluginAdapter } from "./localindex/index.js";
import { SyncIgnore } from "./ignore/ignore.js";
import { SyncTransport } from "./sync/transport.js";
import { SyncEngine } from "./sync/engine.js";
import { InitialSyncRunner } from "./sync/initial-sync.js";
import { VaultWatcher } from "./watcher/vault-watcher.js";
import { ConflictStore } from "./conflict/conflict-store.js";
import { ConflictPanel, VIEW_TYPE_CONFLICTS } from "./conflict/conflict-panel.js";
import { ManualChoiceModal, TextMergeModal, conflictResolvedVV } from "./conflict/merge-view.js";
import { localConfigIgnorePatterns } from "./configsync/configsync.js";
import type { VaultIO, VaultFileInfo } from "./sync/vault-io.js";
import type { ConflictRecord } from "@obsidian-sync/shared";

const STATE_PATH = ".obsidian/plugins/obsidian-sync/state.json";

function mergeSettings(data: unknown): PluginSettings {
  const input = (data && typeof data === "object") ? data as Partial<PluginSettings> : {};
  return ensureDeviceId({ ...DEFAULT_SETTINGS, ...input, configSync: { ...DEFAULT_SETTINGS.configSync, ...(input.configSync ?? {}) } });
}

function decodeBase64(data: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(data, "base64").toString("utf8");
  return decodeURIComponent(escape(atob(data)));
}

class ObsidianAdapterStore implements PluginAdapter {
  constructor(private readonly adapter: DataAdapter) {}
  exists(path: string): Promise<boolean> { return this.adapter.exists(path); }
  read(path: string): Promise<string> { return this.adapter.read(path); }
  write(path: string, data: string): Promise<void> { return this.adapter.write(path, data); }
  remove(path: string): Promise<void> { return this.adapter.remove(path); }
  rename(oldPath: string, newPath: string): Promise<void> { return this.adapter.rename(oldPath, newPath); }
  async mkdir(path: string): Promise<void> { await this.adapter.mkdir(path); }
}

class ObsidianVaultIO implements VaultIO {
  constructor(private readonly plugin: Plugin) {}
  listFiles(): VaultFileInfo[] { return this.plugin.app.vault.getFiles().map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size })); }
  async readText(path: string): Promise<string> { return this.plugin.app.vault.read(this.requireFile(path)); }
  async readBytes(path: string): Promise<Uint8Array> { return new Uint8Array(await this.plugin.app.vault.readBinary(this.requireFile(path))); }
  async writeText(path: string, text: string): Promise<void> {
    await this.ensureParent(path);
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.plugin.app.vault.modify(existing, text);
    else await this.plugin.app.vault.create(path, text);
  }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureParent(path);
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (existing instanceof TFile) await this.plugin.app.vault.modifyBinary(existing, buffer);
    else await this.plugin.app.vault.createBinary(path, buffer);
  }
  async rename(oldPath: string, newPath: string): Promise<void> { await this.ensureParent(newPath); await this.plugin.app.vault.rename(this.requireFile(oldPath), newPath); }
  async trash(path: string, system: boolean): Promise<void> { await this.plugin.app.vault.trash(this.requireFile(path), system); }
  exists(path: string): boolean { return this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile; }
  private requireFile(path: string): TFile {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    return file;
  }
  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
        try { await this.plugin.app.vault.createFolder(current); } catch { /* folder was created concurrently */ }
      }
    }
  }
}

export default class ObsidianSyncPlugin extends Plugin {
  override settings: PluginSettings = DEFAULT_SETTINGS;
  private index!: LocalIndexStore;
  private transport!: SyncTransport;
  private engine!: SyncEngine;
  private watcher!: VaultWatcher;
  private conflictStore = new ConflictStore();
  private statusEl: HTMLElement | null = null;
  private activeFileId: string | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensurePluginDir();
    const adapterStore = new ObsidianAdapterStore(this.app.vault.adapter);
    this.index = new LocalIndexStore(adapterStore, STATE_PATH, this.settings.deviceId);
    await this.index.load();
    this.transport = new SyncTransport(this.settings.serverUrl);
    const vaultIO = new ObsidianVaultIO(this);
    this.engine = new SyncEngine(this.settings, this.index, vaultIO, this.transport, {
      onState: (state, detail) => this.setStatus(detail ? `${state}: ${detail}` : state),
      onConflict: (conflict) => { this.conflictStore.upsert(conflict); new Notice("Sync conflict requires manual resolution"); },
      onError: (error) => new Notice(`Sync error: ${error.message}`),
    });
    const ignore = new SyncIgnore({ common: parseIgnoreLines(this.settings.commonIgnore), local: [...parseIgnoreLines(this.settings.localIgnore), ...localConfigIgnorePatterns(this.settings)] });
    this.watcher = new VaultWatcher(vaultIO, this.index, this.engine, ignore);
    this.statusEl = this.addStatusBarItem();
    this.setStatus(this.settings.paused ? "paused" : "loading");
    this.addSettingTab(new ObsidianSyncSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_CONFLICTS, (leaf) => new ConflictPanel(leaf, this.conflictStore, this.transport, (conflict) => void this.openMerge(conflict)));
    this.registerCommands();
    this.registerVaultEvents();
    this.engine.start();
    if (this.settings.syncOnStartup && !this.settings.paused) {
      if (this.index.device.appliedSeq === 0 && this.index.files.length === 0) {
        void new InitialSyncRunner(this.transport, this.index, vaultIO, this.settings.vaultId).run()
          .catch((error: unknown) => new Notice(`Initial sync failed: ${error instanceof Error ? error.message : String(error)}`));
      } else {
        await this.watcher.reconcile();
      }
    }
  }

  override async onunload(): Promise<void> {
    if (this.activeFileId) this.engine.demote(this.activeFileId);
    await this.engine?.stop();
  }

  async saveSettingsOnly(): Promise<void> { await this.saveData(this.settings); }
  async saveSettingsAndRestart(): Promise<void> {
    await this.saveSettingsOnly();
    if (this.engine) await this.engine.stop();
    this.transport = new SyncTransport(this.settings.serverUrl);
    this.setStatus("restart required");
  }

  private async loadSettings(): Promise<void> { this.settings = mergeSettings(await this.loadData()); await this.saveSettingsOnly(); }

  private async ensurePluginDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(".obsidian/plugins"))) await adapter.mkdir(".obsidian/plugins");
    if (!(await adapter.exists(".obsidian/plugins/obsidian-sync"))) await adapter.mkdir(".obsidian/plugins/obsidian-sync");
  }

  private registerCommands(): void {
    this.addCommand({ id: "resync", name: "Resync from server", callback: () => this.engine.requestResync() });
    this.addCommand({ id: "open-conflicts", name: "Open conflicts panel", callback: () => void this.activateConflictsView() });
    this.addCommand({ id: "pause-resume", name: "Pause/resume sync", callback: async () => { this.settings.paused = !this.settings.paused; if (this.settings.paused) this.engine.pause(); else this.engine.resume(); await this.saveSettingsOnly(); } });
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => { if (file instanceof TFile) this.watcher.queuePath(file.path); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (file instanceof TFile) this.watcher.queuePath(file.path); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (file instanceof TFile) void this.watcher.handleDelete(file.path); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (file instanceof TFile) void this.watcher.handleRename(oldPath, file.path); }));
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (this.activeFileId) this.engine.demote(this.activeFileId);
      const entry = file instanceof TFile ? this.index.byPath(file.path) : undefined;
      this.activeFileId = entry?.fileId ?? null;
      if (this.activeFileId) this.engine.promote(this.activeFileId);
    }));
  }

  private async activateConflictsView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS);
    const leaf = leaves[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CONFLICTS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async openMerge(conflict: ConflictRecord): Promise<void> {
    this.transport.send({ t: "claim_conflict", conflictId: conflict.conflictId });
    if (conflict.kind !== "content") {
      new ManualChoiceModal(this.app, "Resolve non-text conflict", [
        { label: "Use ours", action: () => this.resolveByHash(conflict, conflict.oursHash) },
        { label: "Use theirs", action: () => this.resolveByHash(conflict, conflict.theirsHash) },
      ]).open();
      return;
    }
    const [base, ours, theirs] = await Promise.all([this.fetchText(conflict.baseHash), this.fetchText(conflict.oursHash), this.fetchText(conflict.theirsHash)]);
    new TextMergeModal(this.app, conflict, base, ours, theirs, this.settings.deviceId, this.transport).open();
  }

  private resolveByHash(conflict: ConflictRecord, hash: string | null): void {
    if (!hash) { new Notice("Selected side has no content hash"); return; }
    this.transport.send({ t: "resolve_conflict", conflictId: conflict.conflictId, resolvedHash: hash, resolvedVV: conflictResolvedVV(conflict.oursVV ?? {}, conflict.theirsVV ?? {}, this.settings.deviceId) });
  }

  private async fetchText(hash: string | null): Promise<string> {
    if (!hash) return "";
    const wait = this.transport.waitFor("content", (msg) => msg.hash === hash);
    this.transport.send({ t: "get_content", hash });
    const msg = await wait;
    return msg.data ? decodeBase64(msg.data) : "";
  }

  private setStatus(text: string): void { if (this.statusEl) this.statusEl.setText(`Sync: ${text}`); }
}
