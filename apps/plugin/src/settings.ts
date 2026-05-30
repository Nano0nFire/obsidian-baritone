export type RemoteDeleteTarget = "obsidian-trash" | "system-trash";
export type ConfigCategory = "app" | "corePlugins" | "communityPlugins" | "pluginSettings" | "themesSnippets" | "workspace";
export type ConfigSyncMode = "common" | "local";

export interface ConfigCategoryInfo {
  key: ConfigCategory;
  label: string;
  description: string;
}

export const CONFIG_CATEGORIES: readonly ConfigCategoryInfo[] = [
  { key: "app", label: "App settings", description: "app.json, appearance.json, and hotkeys.json." },
  { key: "corePlugins", label: "Core plugins", description: "Obsidian's core plugin enablement list." },
  { key: "communityPlugins", label: "Community plugins", description: "Community plugin enablement plus plugin manifest, main.js, and styles.css files." },
  { key: "pluginSettings", label: "Plugin settings", description: "Per-plugin data.json settings files." },
  { key: "themesSnippets", label: "Themes and snippets", description: "Files under .obsidian/themes and .obsidian/snippets." },
  { key: "workspace", label: "Workspace layout", description: "workspace*.json layout state. Usually best kept device-local." },
] as const;

export interface ContentEncryptionSettings {
  enabled: boolean;
  /** Base64 PBKDF2 salt generated locally per vault and never sent to the server. */
  salt?: string;
  /** Base64 encrypted verifier used to reject wrong passphrases without storing the passphrase. */
  verifier?: string;
}

export interface PluginSettings {
  serverUrl: string;
  vaultId: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  remoteDeleteTarget: RemoteDeleteTarget;
  contentEncryption: ContentEncryptionSettings;
  configSync: Record<ConfigCategory, ConfigSyncMode>;
  commonIgnore: string;
  localIgnore: string;
  paused: boolean;
  syncOnStartup: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "ws://localhost:3000/sync",
  vaultId: "default",
  username: "",
  accessToken: "",
  refreshToken: "",
  deviceId: "",
  remoteDeleteTarget: "obsidian-trash",
  contentEncryption: { enabled: false },
  configSync: {
    app: "common",
    corePlugins: "common",
    communityPlugins: "common",
    pluginSettings: "common",
    themesSnippets: "common",
    workspace: "local",
  },
  commonIgnore: "",
  localIgnore: "",
  paused: false,
  syncOnStartup: true,
};

export function ensureDeviceId(settings: PluginSettings): PluginSettings {
  if (settings.deviceId) return settings;
  return { ...settings, deviceId: globalThis.crypto?.randomUUID?.() ?? `device-${Date.now().toString(36)}` };
}

export function parseIgnoreLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
