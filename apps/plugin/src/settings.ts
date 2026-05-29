export type RemoteDeleteTarget = "obsidian-trash" | "system-trash";
export type ConfigCategory = "app" | "corePlugins" | "communityPlugins" | "pluginSettings" | "themesSnippets" | "workspace";
export type ConfigSyncMode = "common" | "local";

export interface PluginSettings {
  serverUrl: string;
  vaultId: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  remoteDeleteTarget: RemoteDeleteTarget;
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
