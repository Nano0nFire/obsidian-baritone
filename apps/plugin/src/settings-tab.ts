import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianSyncPlugin from "./main.js";
import type { ConfigCategory } from "./settings.js";

function httpFromWs(url: string): string {
  if (url.startsWith("ws://")) return `http://${url.slice(5)}`;
  if (url.startsWith("wss://")) return `https://${url.slice(6)}`;
  return url;
}

class LoginModal extends Modal {
  private username = "";
  private password = "";
  constructor(app: App, private readonly plugin: ObsidianSyncPlugin) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Login to Obsidian Sync" });
    new Setting(this.contentEl).setName("Username").addText((text) => text.onChange((value) => { this.username = value; }));
    new Setting(this.contentEl).setName("Password").addText((text) => { text.inputEl.type = "password"; text.onChange((value) => { this.password = value; }); });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Login").setCta().onClick(() => void this.login()));
  }
  private async login(): Promise<void> {
    try {
      const base = httpFromWs(this.plugin.settings.serverUrl).replace(/\/sync$/, "");
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: this.username, password: this.password, deviceId: this.plugin.settings.deviceId, vaultId: this.plugin.settings.vaultId }),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = await response.json() as { accessToken?: string; refreshToken?: string; deviceId?: string };
      if (!data.accessToken || !data.refreshToken) throw new Error("Login response missing tokens");
      this.plugin.settings.username = this.username;
      this.plugin.settings.accessToken = data.accessToken;
      this.plugin.settings.refreshToken = data.refreshToken;
      if (data.deviceId) this.plugin.settings.deviceId = data.deviceId;
      await this.plugin.saveSettingsAndRestart();
      new Notice("Logged in");
      this.close();
    } catch (error) {
      new Notice(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const CATEGORY_LABELS: Record<ConfigCategory, string> = {
  app: "App settings",
  corePlugins: "Core plugins",
  communityPlugins: "Community plugin binaries",
  pluginSettings: "Plugin settings",
  themesSnippets: "Themes and snippets",
  workspace: "Workspace layout",
};

export class ObsidianSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianSyncPlugin) { super(app, plugin); }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Sync" });
    new Setting(containerEl).setName("Server WebSocket URL").setDesc("Example: wss://sync.example.com/sync").addText((text) => text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => { this.plugin.settings.serverUrl = value.trim(); await this.plugin.saveSettingsOnly(); }));
    new Setting(containerEl).setName("Vault ID").addText((text) => text.setValue(this.plugin.settings.vaultId).onChange(async (value) => { this.plugin.settings.vaultId = value.trim() || "default"; await this.plugin.saveSettingsOnly(); }));
    new Setting(containerEl).setName("Device ID").setDesc(this.plugin.settings.deviceId).addButton((button) => button.setButtonText("Regenerate").onClick(async () => { this.plugin.settings.deviceId = crypto.randomUUID(); await this.plugin.saveSettingsAndRestart(); this.display(); }));
    new Setting(containerEl).setName("Login").setDesc(this.plugin.settings.username ? `Logged in as ${this.plugin.settings.username}` : "No credentials stored").addButton((button) => button.setButtonText("Login").setCta().onClick(() => new LoginModal(this.app, this.plugin).open()));
    new Setting(containerEl).setName("Remote deletes").setDesc("Where files deleted by remote ops are moved locally.").addDropdown((drop) => drop.addOption("obsidian-trash", "Obsidian .trash").addOption("system-trash", "System trash").setValue(this.plugin.settings.remoteDeleteTarget).onChange(async (value) => { this.plugin.settings.remoteDeleteTarget = value as typeof this.plugin.settings.remoteDeleteTarget; await this.plugin.saveSettingsOnly(); }));
    new Setting(containerEl).setName("Pause sync").addToggle((toggle) => toggle.setValue(this.plugin.settings.paused).onChange(async (value) => { this.plugin.settings.paused = value; await this.plugin.saveSettingsAndRestart(); }));
    containerEl.createEl("h3", { text: "Config sync" });
    for (const key of Object.keys(CATEGORY_LABELS) as ConfigCategory[]) {
      new Setting(containerEl).setName(CATEGORY_LABELS[key]).addDropdown((drop) => drop.addOption("common", "Common").addOption("local", "Local only").setValue(this.plugin.settings.configSync[key]).onChange(async (value) => { this.plugin.settings.configSync[key] = value as "common" | "local"; await this.plugin.saveSettingsOnly(); }));
    }
    containerEl.createEl("h3", { text: ".ignore" });
    new Setting(containerEl).setName("Common ignore rules").setDesc("Synced layer. Gitignore syntax subset.").addTextArea((text) => { text.inputEl.rows = 6; text.setValue(this.plugin.settings.commonIgnore).onChange(async (value) => { this.plugin.settings.commonIgnore = value; await this.plugin.saveSettingsAndRestart(); }); });
    new Setting(containerEl).setName("Local ignore rules").setDesc("Device-local layer.").addTextArea((text) => { text.inputEl.rows = 6; text.setValue(this.plugin.settings.localIgnore).onChange(async (value) => { this.plugin.settings.localIgnore = value; await this.plugin.saveSettingsAndRestart(); }); });
  }
}
