import { Modal, Notice, Plugin, TFile, type App, type DataAdapter } from "obsidian";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { DEFAULT_SETTINGS, ensureDeviceId, parseIgnoreLines, type PluginSettings } from "./settings.js";
import { ObsidianSyncSettingTab } from "./settings-tab.js";
import { LocalIndexStore, type PluginAdapter } from "./localindex/index.js";
import { SyncIgnore } from "./ignore/ignore.js";
import { SyncTransport } from "./sync/transport.js";
import { SyncEngine } from "./sync/engine.js";
import { YjsSessionManager, type YjsSession } from "./sync/yjs-session.js";
import { makeLocalAwarenessState, reduceAwarenessStates, type PresenceParticipant } from "./sync/awareness-ui.js";
import { InitialSyncRunner } from "./sync/initial-sync.js";
import { ForceSyncRunner } from "./sync/force-runner.js";
import { VaultWatcher, classifyFileType } from "./watcher/vault-watcher.js";
import { canonicalVaultPath } from "./pathing.js";
import type { LocalFileSnapshot } from "./sync/force-sync.js";
import { refreshSessionTokens } from "./auth-client.js";
import { ConflictStore } from "./conflict/conflict-store.js";
import { ConflictPanel, VIEW_TYPE_CONFLICTS } from "./conflict/conflict-panel.js";
import { ManualChoiceModal, TextMergeModal, conflictResolvedVV } from "./conflict/merge-view.js";
import { localConfigIgnorePatterns } from "./configsync/configsync.js";
import { requestUrlFetch } from "./http.js";
import type { VaultIO, VaultFileInfo } from "./sync/vault-io.js";
import { SyncLogPanel, VIEW_TYPE_LOGS } from "./logs/log-panel.js";
import { SyncLogStore, type SyncLogEntryInput, type SyncLogLevel } from "./logs/log-store.js";
import {
  base64ToBytes,
  bytesToBase64,
  contentHash,
  createEncryptionVerifier,
  decryptVaultBytes,
  ErrorCode,
  deriveVaultContentKey,
  isEncryptedBlobEnvelope,
  randomEncryptionSalt,
  verifyEncryptionPassphrase,
  type ConflictRecord,
  type SnapshotVersionMetadata,
  type VaultContentKey,
} from "@obsidian-sync/shared";

const STATE_PATH = ".obsidian/plugins/obsidian-sync/state.json";
const PLUGIN_PRIVATE_DIR = ".obsidian/plugins/obsidian-sync/";

type AwarenessCursor = { anchor: Y.RelativePosition; head: Y.RelativePosition };

function isAwarenessCursor(value: unknown): value is AwarenessCursor {
  return !!value && typeof value === "object" && "anchor" in value && "head" in value;
}

function sameCursor(current: unknown, next: AwarenessCursor): boolean {
  if (!isAwarenessCursor(current)) return false;
  try {
    return Y.compareRelativePositions(current.anchor, next.anchor) && Y.compareRelativePositions(current.head, next.head);
  } catch {
    return false;
  }
}

function publishLocalCursor(view: EditorView, session: YjsSession): void {
  const localState = session.awareness.getLocalState();
  if (!localState) return;
  if (!view.hasFocus || !view.dom.ownerDocument.hasFocus()) {
    if (localState.cursor != null) session.awareness.setLocalStateField("cursor", null);
    return;
  }
  const selection = view.state.selection.main;
  const cursor = {
    anchor: Y.createRelativePositionFromTypeIndex(session.text, selection.anchor),
    head: Y.createRelativePositionFromTypeIndex(session.text, selection.head),
  };
  if (!sameCursor(localState.cursor, cursor)) session.awareness.setLocalStateField("cursor", cursor);
}

function localAwarenessCursorExtension(session: YjsSession): Extension {
  return ViewPlugin.fromClass(class implements PluginValue {
    constructor(private readonly view: EditorView) { publishLocalCursor(view, session); }
    update(update: ViewUpdate): void {
      if (update.selectionSet || update.focusChanged || update.docChanged) publishLocalCursor(update.view, session);
    }
    destroy(): void {
      const localState = session.awareness.getLocalState();
      if (localState?.cursor != null) session.awareness.setLocalStateField("cursor", null);
    }
  });
}

function mergeSettings(data: unknown): PluginSettings {
  const input = (data && typeof data === "object") ? data as Partial<PluginSettings> : {};
  return ensureDeviceId({
    ...DEFAULT_SETTINGS,
    ...input,
    contentEncryption: { ...DEFAULT_SETTINGS.contentEncryption, ...(input.contentEncryption ?? {}) },
    configSync: { ...DEFAULT_SETTINGS.configSync, ...(input.configSync ?? {}) },
  });
}

function decodeBase64Bytes(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
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
  private readonly logStore = new SyncLogStore();
  private index!: LocalIndexStore;
  private transport!: SyncTransport;
  private engine!: SyncEngine;
  private yjsManager!: YjsSessionManager;
  private watcher!: VaultWatcher;
  private conflictStore = new ConflictStore();
  private statusEl: HTMLElement | null = null;
  private presenceEl: HTMLElement | null = null;
  private activeFileId: string | null = null;
  private activeOpenToken = 0;
  private contentEncryptionKey: VaultContentKey | null = null;
  private activeAwarenessCleanup: (() => void) | null = null;
  private readonly yjsEditorExtensions: Extension[] = [];
  private vaultIO!: VaultIO;
  private ignore!: SyncIgnore;
  private forceSyncInProgress = false;
  private refreshInFlight: Promise<boolean> | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensurePluginDir();
    this.appendLog({ level: "info", source: "plugin", message: "Plugin loading" });
    const adapterStore = new ObsidianAdapterStore(this.app.vault.adapter);
    this.index = new LocalIndexStore(adapterStore, STATE_PATH, this.settings.deviceId, this.settings.vaultId);
    await this.index.load();
    const vaultIO = new ObsidianVaultIO(this);
    this.vaultIO = vaultIO;
    this.statusEl = this.addStatusBarItem();
    this.presenceEl = this.addStatusBarItem();
    this.presenceEl.classList.add("obsidian-sync-presence");
    this.setStatus(this.settings.paused ? "paused" : "loading");
    this.renderPresence([]);
    this.addSettingTab(new ObsidianSyncSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_CONFLICTS, (leaf) => new ConflictPanel(leaf, this.conflictStore, this.transport, (conflict) => void this.openMerge(conflict)));
    this.registerView(VIEW_TYPE_LOGS, (leaf) => new SyncLogPanel(leaf, this.logStore));
    this.registerEditorExtension(this.yjsEditorExtensions);
    this.registerCommands();
    this.registerVaultEvents();
    await this.startSyncServices();
    await this.runStartupSync();
  }

  override async onunload(): Promise<void> {
    const fileId = this.activeFileId;
    this.activeFileId = null;
    this.setYjsEditorSession(null);
    if (fileId) await this.yjsManager.leaveFile(fileId);
    await this.engine?.stop();
  }

  encryptionUnlocked(): boolean { return !this.settings.contentEncryption.enabled || this.contentEncryptionKey !== null; }

  private buildForceRunner(): ForceSyncRunner {
    const manifest = new InitialSyncRunner(this.transport, this.index, this.vaultIO, this.settings.vaultId, () => this.contentEncryptionKey);
    return new ForceSyncRunner(this.engine, manifest, this.index, this.vaultIO, this.watcher, { remoteDeleteSystemTrash: this.settings.remoteDeleteTarget === "system-trash" });
  }

  private syncableLocalPaths(): string[] {
    return this.vaultIO.listFiles()
      .map((file) => canonicalVaultPath(file.path))
      .filter((path) => !path.startsWith(PLUGIN_PRIVATE_DIR) && !this.ignore.ignores(path));
  }

  private guardForce(): boolean {
    if (this.forceSyncInProgress) { new Notice("A force sync is already running."); return false; }
    if (this.settings.paused) { new Notice("Resume sync before running a force operation."); return false; }
    if (!this.engine?.isWriteReady()) { new Notice("Wait for sync catch-up to finish, then retry."); return false; }
    if (!this.encryptionUnlocked()) { new Notice("Unlock vault encryption before running a force operation."); return false; }
    return true;
  }

  async forcePushToRemote(): Promise<void> {
    if (!this.guardForce()) return;
    this.forceSyncInProgress = true;
    this.setStatus("force push…");
    this.appendLog({ level: "warn", source: "force-sync", message: "Force push started (local → remote)" });
    try {
      const snapshots: LocalFileSnapshot[] = [];
      for (const path of this.syncableLocalPaths()) {
        snapshots.push({ path, hash: await this.engine.hashPath(path), type: classifyFileType(path), fileId: this.index.byPath(path)?.fileId });
      }
      const result = await this.buildForceRunner().forcePush(snapshots);
      if (result.ok) {
        this.appendLog({ level: "warn", source: "force-sync", message: `Force push complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted on the server` });
        new Notice(`Force push complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted on the server.`);
      } else {
        this.appendLog({ level: "warn", source: "force-sync", message: `Force push blocked (${result.blocked})${result.message ? `: ${result.message}` : ""}` });
        new Notice(`Force push blocked (${result.blocked})${result.message ? `: ${result.message}` : ""}.`);
      }
    } catch (error) {
      this.appendLog({ level: "error", source: "force-sync", message: `Force push failed: ${error instanceof Error ? error.message : String(error)}` });
      new Notice(`Force push failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.forceSyncInProgress = false;
      this.setStatus(this.settings.paused ? "paused" : "syncing");
    }
  }

  async forcePullFromRemote(): Promise<void> {
    if (!this.guardForce()) return;
    this.forceSyncInProgress = true;
    this.setStatus("force pull…");
    this.appendLog({ level: "warn", source: "force-sync", message: "Force pull started (remote → local)" });
    try {
      const result = await this.buildForceRunner().forcePull(this.syncableLocalPaths());
      if (result.ok) {
        this.appendLog({ level: "warn", source: "force-sync", message: `Force pull complete: ${result.written} files written, ${result.trashed} local strays removed` });
        new Notice(`Force pull complete: ${result.written} files written, ${result.trashed} local strays removed.`);
      } else {
        this.appendLog({ level: "warn", source: "force-sync", message: `Force pull blocked (${result.blocked})` });
        new Notice(`Force pull blocked (${result.blocked}).`);
      }
    } catch (error) {
      this.appendLog({ level: "error", source: "force-sync", message: `Force pull failed: ${error instanceof Error ? error.message : String(error)}` });
      new Notice(`Force pull failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.forceSyncInProgress = false;
      this.setStatus(this.settings.paused ? "paused" : "syncing");
    }
  }

  async configureContentEncryption(passphrase: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      if (this.settings.contentEncryption.salt && this.settings.contentEncryption.verifier) {
        const salt = base64ToBytes(this.settings.contentEncryption.salt);
        if (!(await verifyEncryptionPassphrase(passphrase, salt, this.settings.contentEncryption.verifier))) throw new Error("Encryption passphrase did not match the stored verifier");
      }
      this.contentEncryptionKey = null;
      this.settings.contentEncryption = { enabled: false };
      await this.saveSettingsAndRestart();
      return;
    }
    const salt = this.settings.contentEncryption.salt ? base64ToBytes(this.settings.contentEncryption.salt) : randomEncryptionSalt();
    const verifier = this.settings.contentEncryption.verifier ?? await createEncryptionVerifier(passphrase, salt);
    if (!(await verifyEncryptionPassphrase(passphrase, salt, verifier))) throw new Error("Encryption passphrase did not match the stored verifier");
    this.contentEncryptionKey = await deriveVaultContentKey(passphrase, salt);
    this.settings.contentEncryption = { enabled: true, salt: bytesToBase64(salt), verifier };
    await this.saveSettingsAndRestart();
  }

  async saveSettingsOnly(): Promise<void> { await this.saveData(this.settings); }
  async saveSettingsAndRestart(): Promise<void> {
    await this.saveSettingsOnly();
    await this.restartSyncServices("Settings saved; sync restarted");
  }

  appendLog(entry: SyncLogEntryInput): void {
    this.logStore.append(entry);
  }

  async openLogViewer(): Promise<void> {
    await this.activateLogsView();
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
    this.addCommand({ id: "open-sync-log", name: "Open sync log", callback: () => void this.openLogViewer() });
    this.addCommand({ id: "show-version-history", name: "Show version history for current note", callback: () => void this.showCurrentNoteHistory() });
    this.addCommand({ id: "pause-resume", name: "Pause/resume sync", callback: async () => { this.settings.paused = !this.settings.paused; if (this.settings.paused) this.engine.pause(); else this.engine.resume(); await this.saveSettingsOnly(); } });
  }

  private async showCurrentNoteHistory(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("Open a synced Markdown note to view history");
      return;
    }
    const entry = this.index.byPath(file.path);
    if (!entry) {
      new Notice("This note is not in the sync index yet");
      return;
    }
    const modal = new VersionHistoryModal(this.app, this.yjsManager, entry.fileId, file.path, async (text) => {
      await this.app.vault.modify(file, text);
      new Notice("Restored version applied");
    });
    modal.open();
    await modal.load();
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => { if (file instanceof TFile) this.watcher.queuePath(file.path); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (file instanceof TFile) this.watcher.queuePath(file.path); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (file instanceof TFile) void this.watcher.handleDelete(file.path); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (file instanceof TFile) void this.watcher.handleRename(oldPath, file.path); }));
    this.registerEvent(this.app.workspace.on("file-open", (file) => { void this.activateRealtimeFile(file instanceof TFile ? file : null); }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { void this.activateRealtimeFile(this.app.workspace.getActiveFile()); }));
  }

  private async activateRealtimeFile(file: TFile | null): Promise<void> {
    const token = ++this.activeOpenToken;
    const previous = this.activeFileId;
    const entry = file?.extension === "md" ? this.index.byPath(file.path) : undefined;
    const nextFileId = entry?.fileId ?? null;
    if (previous && previous !== nextFileId) {
      this.activeFileId = null;
      this.setYjsEditorSession(null);
      await this.yjsManager.leaveFile(previous);
    }
    if (!nextFileId) {
      this.activeFileId = null;
      this.setYjsEditorSession(null);
      return;
    }
    if (previous === nextFileId && this.yjsManager.hasSession(nextFileId)) return;
    this.activeFileId = nextFileId;
    try {
      const session = await this.yjsManager.openFile(nextFileId);
      if (token !== this.activeOpenToken || this.activeFileId !== nextFileId) {
        if (this.activeFileId !== nextFileId) await this.yjsManager.leaveFile(nextFileId);
        return;
      }
      this.setYjsEditorSession(session);
    } catch (error) {
      if (token === this.activeOpenToken) {
        this.activeFileId = null;
        this.setYjsEditorSession(null);
        new Notice(`Realtime sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private setYjsEditorSession(session: YjsSession | null): void {
    this.activeAwarenessCleanup?.();
    this.activeAwarenessCleanup = null;
    if (session) {
      session.awareness.setLocalState(makeLocalAwarenessState(this.settings));
      const updatePresence = () => this.renderPresence(reduceAwarenessStates(session.awareness.getStates(), session.awareness.clientID));
      session.awareness.on("change", updatePresence);
      this.activeAwarenessCleanup = () => {
        session.awareness.off("change", updatePresence);
        if (session.awareness.getLocalState()) session.awareness.setLocalState(null);
        this.renderPresence([]);
      };
      updatePresence();
    } else {
      this.renderPresence([]);
    }
    this.yjsEditorExtensions.splice(0, this.yjsEditorExtensions.length, ...(session ? [yCollab(session.text, session.awareness), localAwarenessCursorExtension(session)] : []));
    this.app.workspace.updateOptions();
  }

  private renderPresence(participants: readonly PresenceParticipant[]): void {
    if (!this.presenceEl) return;
    this.presenceEl.replaceChildren();
    this.presenceEl.setAttribute("aria-label", participants.length ? `Realtime collaborators: ${participants.map((participant) => participant.name).join(", ")}` : "No active realtime collaborators");
    if (participants.length === 0) {
      this.presenceEl.setText("Presence: solo");
      return;
    }
    const prefix = document.createElement("span");
    prefix.className = "obsidian-sync-presence-prefix";
    prefix.textContent = "Presence:";
    this.presenceEl.appendChild(prefix);
    for (const participant of participants) {
      const chip = document.createElement("span");
      chip.className = `obsidian-sync-presence-chip${participant.hasCursor ? " is-active" : " is-idle"}${participant.isLocal ? " is-local" : ""}`;
      chip.title = `${participant.name}${participant.isLocal ? " (you)" : ""}${participant.hasCursor ? " — editing" : " — idle"}`;
      const dot = document.createElement("span");
      dot.className = "obsidian-sync-presence-dot";
      dot.style.backgroundColor = participant.color;
      const name = document.createElement("span");
      name.className = "obsidian-sync-presence-name";
      name.textContent = `${participant.name}${participant.isLocal ? " (you)" : ""}`;
      chip.append(dot, name);
      this.presenceEl.appendChild(chip);
    }
  }

  private async activateConflictsView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONFLICTS);
    const leaf = leaves[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CONFLICTS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async activateLogsView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LOGS);
    const leaf = leaves[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_LOGS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private createTransport(url: string): SyncTransport {
    return new SyncTransport(url, undefined, {
      onStateChange: (state) => {
        const level: SyncLogLevel = state === "closed" ? "warn" : "info";
        this.appendLog({ level, source: "transport", message: `WebSocket ${state}` });
      },
      onInvalidMessage: (error) => {
        this.appendLog({ level: "error", source: "transport", message: `Dropped invalid server message: ${error.message}` });
      },
    });
  }

  private async startSyncServices(): Promise<void> {
    await this.ensureIndexMatchesDevice();
    this.transport = this.createTransport(this.settings.serverUrl);
    this.yjsManager = new YjsSessionManager(this.transport, {
      canPromote: () => !this.settings.contentEncryption.enabled,
      promoteDisabledReason: "Realtime collaboration is disabled while vault content encryption is enabled",
      onSessionChanged: (fileId, session) => {
        if (this.activeFileId === fileId) this.setYjsEditorSession(session);
      },
    });
    this.engine = new SyncEngine(this.settings, this.index, this.vaultIO, this.transport, {
      onState: (state, detail) => {
        this.setStatus(detail ? `${state}: ${detail}` : state);
        this.appendLog({ level: state === "error" ? "error" : "info", source: "engine", message: detail ? `${state}: ${detail}` : state });
      },
      onConflict: (conflict) => {
        this.conflictStore.upsert(conflict);
        this.appendLog({ level: "warn", source: "conflict", message: `${conflict.kind} conflict ${conflict.conflictId} requires manual resolution` });
        new Notice("Sync conflict requires manual resolution");
      },
      onError: (error) => {
        if (this.shouldRefreshSession(undefined, error.message)) {
          void this.refreshSession("engine error", error.message);
          return;
        }
        this.appendLog({ level: "error", source: "engine", message: error.message });
        new Notice(`Sync error: ${error.message}`);
      },
      onReject: (opId, code, message) => {
        this.appendLog({ level: "warn", source: "engine", message: `Server rejected ${opId}: ${code} — ${message}` });
        if (this.shouldRefreshSession(code, message)) void this.refreshSession("server reject", `${code}: ${message}`);
      },
    }, this.yjsManager, () => this.contentEncryptionKey, requestUrlFetch);
    this.ignore = new SyncIgnore({ common: parseIgnoreLines(this.settings.commonIgnore), local: [...parseIgnoreLines(this.settings.localIgnore), ...localConfigIgnorePatterns(this.settings)] });
    this.watcher = new VaultWatcher(this.vaultIO, this.index, this.engine, this.ignore);
    if (this.settings.contentEncryption.enabled && !this.contentEncryptionKey) new Notice("Vault content encryption is enabled. Enter the passphrase in sync settings before syncing content.");
    this.engine.start();
    this.appendLog({ level: "info", source: "plugin", message: "Sync engine started" });
  }

  private async ensureIndexMatchesDevice(): Promise<void> {
    if (this.index.device.deviceId === this.settings.deviceId && this.index.device.vaultId === this.settings.vaultId) return;
    this.index.resetSessionState(this.settings.deviceId, this.settings.vaultId);
    await this.index.save();
  }

  private async stopSyncServices(): Promise<void> {
    const activeFileId = this.activeFileId;
    this.activeFileId = null;
    this.setYjsEditorSession(null);
    if (activeFileId) await this.yjsManager.leaveFile(activeFileId);
    if (this.engine) await this.engine.stop();
  }

  private async restartSyncServices(reason: string): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    await this.stopSyncServices();
    await this.startSyncServices();
    this.appendLog({ level: "info", source: "plugin", message: reason });
    await this.runStartupSync();
    await this.activateRealtimeFile(activeFile instanceof TFile ? activeFile : null);
  }

  private async runStartupSync(): Promise<void> {
    if (!this.settings.syncOnStartup || this.settings.paused) return;
    if (this.index.device.appliedSeq === 0 && this.index.files.length === 0) {
      this.appendLog({ level: "info", source: "initial-sync", message: "Initial sync started" });
      try {
        await new InitialSyncRunner(this.transport, this.index, this.vaultIO, this.settings.vaultId, () => this.contentEncryptionKey).run();
        this.appendLog({ level: "info", source: "initial-sync", message: "Initial sync completed" });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendLog({ level: "error", source: "initial-sync", message: `Initial sync failed: ${message}` });
        new Notice(`Initial sync failed: ${message}`);
      }
      return;
    }
    await this.watcher.reconcile();
  }

  private shouldRefreshSession(code?: string, message?: string): boolean {
    const detail = `${code ?? ""} ${message ?? ""}`;
    return code === ErrorCode.TOKEN_EXPIRED
      || /\bTOKEN_EXPIRED\b/.test(detail)
      || (code === ErrorCode.UNAUTHENTICATED && /"exp" claim timestamp check failed/.test(message ?? ""))
      || /"exp" claim timestamp check failed/.test(detail);
  }

  private async refreshSession(source: string, detail: string): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!this.settings.refreshToken) {
      this.appendLog({ level: "error", source: "auth", message: `Session expired during ${source}, but no refresh token is stored` });
      new Notice("Session expired. Log in again.");
      return false;
    }
    const run = (async () => {
      this.appendLog({ level: "warn", source: "auth", message: `Session expired during ${source}; refreshing token` });
      try {
        const tokens = await refreshSessionTokens(this.settings.serverUrl, this.settings.refreshToken, requestUrlFetch);
        this.settings.accessToken = tokens.accessToken;
        this.settings.refreshToken = tokens.refreshToken;
        this.settings.deviceId = tokens.deviceId;
        await this.saveSettingsOnly();
        await this.restartSyncServices("Session refreshed; reconnecting");
        this.appendLog({ level: "info", source: "auth", message: "Session refresh succeeded" });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendLog({ level: "error", source: "auth", message: `Session refresh failed after ${detail}: ${message}` });
        new Notice("Session expired. Log in again.");
        return false;
      }
    })();
    this.refreshInFlight = run;
    try {
      return await run;
    } finally {
      if (this.refreshInFlight === run) this.refreshInFlight = null;
    }
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
    if (!msg.data) return "";
    let bytes = decodeBase64Bytes(msg.data);
    if ((await contentHash(bytes)) !== hash) throw new Error(`Hash verification failed for ${hash}`);
    if (this.settings.contentEncryption.enabled) {
      if (!isEncryptedBlobEnvelope(bytes)) throw new Error(`Unsupported encrypted content format for ${hash}`);
      if (!this.contentEncryptionKey) throw new Error("Vault content encryption is enabled but no passphrase has been unlocked for this session");
      bytes = await decryptVaultBytes(bytes, this.contentEncryptionKey);
    }
    return new TextDecoder().decode(bytes);
  }

  private setStatus(text: string): void { if (this.statusEl) this.statusEl.setText(`Sync: ${text}`); }
}

class VersionHistoryModal extends Modal {
  private selectedVersion: SnapshotVersionMetadata | null = null;
  private previewEl!: HTMLPreElement;
  private restoreButton!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly yjsManager: YjsSessionManager,
    private readonly fileId: string,
    private readonly path: string,
    private readonly onRestore: (text: string) => Promise<void>,
  ) { super(app); }

  async load(): Promise<void> {
    const page = await this.yjsManager.listHistory(this.fileId, { limit: 50 });
    this.render(page.versions);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Version history: ${this.path}` });
    contentEl.createEl("p", { text: "Loading history…" });
  }

  private render(versions: SnapshotVersionMetadata[]): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Version history: ${this.path}` });
    const list = contentEl.createEl("div", { cls: "obsidian-sync-history-list" });
    if (versions.length === 0) list.createEl("p", { text: "No retained versions yet." });
    for (const version of versions) {
      const button = list.createEl("button", { text: `${new Date(version.createdAt).toLocaleString()} · ${version.reason} · seq ${version.seq}` });
      button.addEventListener("click", () => void this.preview(version));
    }
    this.previewEl = contentEl.createEl("pre", { cls: "obsidian-sync-history-preview" });
    this.previewEl.textContent = "Select a version to preview it.";
    this.restoreButton = contentEl.createEl("button", { text: "Restore selected version" });
    this.restoreButton.disabled = true;
    this.restoreButton.addEventListener("click", () => void this.restoreSelected());
  }

  private async preview(version: SnapshotVersionMetadata): Promise<void> {
    this.selectedVersion = version;
    this.restoreButton.disabled = true;
    this.previewEl.textContent = "Loading preview…";
    const text = await this.yjsManager.fetchHistoryText(this.fileId, version.versionId);
    this.previewEl.textContent = text;
    this.restoreButton.disabled = false;
  }

  private async restoreSelected(): Promise<void> {
    if (!this.selectedVersion) return;
    this.restoreButton.disabled = true;
    const text = await this.yjsManager.restoreHistoryVersion(this.fileId, this.selectedVersion.versionId);
    await this.onRestore(text);
    this.close();
  }
}
