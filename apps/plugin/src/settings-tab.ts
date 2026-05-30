import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianSyncPlugin from "./main.js";
import { CONFIG_CATEGORIES, type ConfigSyncMode } from "./settings.js";

function httpFromWs(url: string): string {
  if (url.startsWith("ws://")) return `http://${url.slice(5)}`;
  if (url.startsWith("wss://")) return `https://${url.slice(6)}`;
  return url;
}

class EncryptionPassphraseModal extends Modal {
  private passphrase = "";
  constructor(app: App, private readonly plugin: ObsidianSyncPlugin, private readonly enable: boolean) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.enable ? "Enable vault content encryption" : "Disable vault content encryption" });
    this.contentEl.createEl("p", { text: this.enable
      ? "Enter the vault encryption passphrase. It is used only locally to derive the session key; only a salt and verifier are stored. Layer 2 realtime collaboration will be disabled."
      : "Enter the current vault encryption passphrase to confirm disabling encryption for future writes. Existing remote ciphertext is not migrated automatically." });
    new Setting(this.contentEl).setName("Passphrase").addText((text) => { text.inputEl.type = "password"; text.onChange((value) => { this.passphrase = value; }); });
    new Setting(this.contentEl).addButton((button) => button.setButtonText(this.enable ? "Enable encryption" : "Disable encryption").setCta().onClick(() => void this.apply()));
  }
  private async apply(): Promise<void> {
    try {
      await this.plugin.configureContentEncryption(this.passphrase, this.enable);
      new Notice(this.enable ? "Vault content encryption enabled for new uploads" : "Vault content encryption disabled for new uploads");
      this.close();
    } catch (error) {
      new Notice(`Encryption setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
    new Setting(containerEl)
      .setName("Vault content encryption")
      .setDesc(this.plugin.settings.contentEncryption.enabled
        ? `Enabled${this.plugin.encryptionUnlocked() ? " and unlocked" : " but locked"}. Server stores Layer 1 ciphertext; realtime collaboration is disabled.`
        : "Off by default. Enable only after reading the migration warning; paths, sizes, and timing are not hidden.")
      .addButton((button) => button
        .setButtonText(this.plugin.settings.contentEncryption.enabled ? "Disable" : "Enable")
        .onClick(() => new EncryptionPassphraseModal(this.app, this.plugin, !this.plugin.settings.contentEncryption.enabled).open()));
    new Setting(containerEl).setName("Pause sync").addToggle((toggle) => toggle.setValue(this.plugin.settings.paused).onChange(async (value) => { this.plugin.settings.paused = value; await this.plugin.saveSettingsAndRestart(); }));
    containerEl.createEl("h3", { text: "Config sync" });
    containerEl.createEl("p", {
      text: "Choose whether each Obsidian configuration category uses the shared COMMON settings or remains DEVICE-LOCAL on this client.",
      cls: "setting-item-description",
    });
    for (const category of CONFIG_CATEGORIES) {
      new Setting(containerEl)
        .setName(category.label)
        .setDesc(category.description)
        .addDropdown((drop) => drop
          .addOption("common", "COMMON synced settings")
          .addOption("local", "DEVICE-LOCAL settings")
          .setValue(this.plugin.settings.configSync[category.key])
          .onChange(async (value) => {
            this.plugin.settings.configSync[category.key] = value as ConfigSyncMode;
            await this.plugin.saveSettingsOnly();
          }));
    }
    containerEl.createEl("h3", { text: ".ignore rules" });
    containerEl.createEl("p", {
      text: "Add gitignore-like rules for files that must not sync. Later negated rules beginning with ! can re-include files.",
      cls: "setting-item-description",
    });
    new Setting(containerEl)
      .setName("Common .ignore")
      .setDesc("Synced to every client. Use for project-wide exclusions such as generated folders or secrets.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("obsidian-sync-ignore-editor");
        text.setPlaceholder("# Synced exclusions\nbuild/\n*.secret\n!important.secret");
        text.setValue(this.plugin.settings.commonIgnore).onChange(async (value) => {
          this.plugin.settings.commonIgnore = value;
          await this.plugin.saveSettingsAndRestart();
        });
      });
    new Setting(containerEl)
      .setName("Device-local .ignore")
      .setDesc("Stored only on this device. Use for machine-specific paths or temporary exports.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("obsidian-sync-ignore-editor");
        text.setPlaceholder("# Local-only exclusions\nexports/\nScratch/");
        text.setValue(this.plugin.settings.localIgnore).onChange(async (value) => {
          this.plugin.settings.localIgnore = value;
          await this.plugin.saveSettingsAndRestart();
        });
      });
  }
}
