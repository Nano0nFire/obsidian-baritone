import type { ConfigCategory, ConfigSyncMode, PluginSettings } from "../settings.js";

export interface ConfigSyncDecision {
  category: ConfigCategory | null;
  mode: ConfigSyncMode;
  applies: boolean;
  reason?: string;
}

export function categorizeConfigPath(path: string): ConfigCategory | null {
  if (!path.startsWith(".obsidian/")) return null;
  const rel = path.slice(".obsidian/".length);
  if (["app.json", "appearance.json", "hotkeys.json"].includes(rel)) return "app";
  if (rel === "core-plugins.json") return "corePlugins";
  if (rel === "community-plugins.json" || /^plugins\/[^/]+\/(manifest\.json|main\.js|styles\.css)$/.test(rel)) return "communityPlugins";
  if (/^plugins\/[^/]+\/data\.json$/.test(rel)) return "pluginSettings";
  if (rel.startsWith("themes/") || rel.startsWith("snippets/")) return "themesSnippets";
  if (/^workspace.*\.json$/.test(rel)) return "workspace";
  return null;
}

export function localConfigIgnorePatterns(settings: PluginSettings): string[] {
  const patterns: string[] = [];
  for (const [category, mode] of Object.entries(settings.configSync) as Array<[ConfigCategory, ConfigSyncMode]>) {
    if (mode !== "local") continue;
    if (category === "app") patterns.push(".obsidian/app.json", ".obsidian/appearance.json", ".obsidian/hotkeys.json");
    if (category === "corePlugins") patterns.push(".obsidian/core-plugins.json");
    if (category === "communityPlugins") patterns.push(".obsidian/community-plugins.json", ".obsidian/plugins/*/manifest.json", ".obsidian/plugins/*/main.js", ".obsidian/plugins/*/styles.css");
    if (category === "pluginSettings") patterns.push(".obsidian/plugins/*/data.json");
    if (category === "themesSnippets") patterns.push(".obsidian/themes/", ".obsidian/snippets/");
    if (category === "workspace") patterns.push(".obsidian/workspace*.json");
  }
  return patterns;
}

export function shouldApplyConfigPath(path: string, settings: PluginSettings, manifest?: { isDesktopOnly?: boolean }, isMobile = false): ConfigSyncDecision {
  const category = categorizeConfigPath(path);
  if (!category) return { category, mode: "local", applies: false, reason: "not config" };
  const mode = settings.configSync[category];
  if (mode === "local") return { category, mode, applies: false, reason: "category local" };
  if (isMobile && manifest?.isDesktopOnly === true) return { category, mode, applies: false, reason: "desktop-only plugin" };
  return { category, mode, applies: true };
}
