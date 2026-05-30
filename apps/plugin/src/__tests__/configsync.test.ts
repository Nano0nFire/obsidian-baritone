import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ConfigCategory } from "../settings.js";
import { categorizeConfigPath, localConfigIgnorePatterns, shouldApplyConfigPath } from "../configsync/configsync.js";

const expectedCategoryExamples: Array<[string, ConfigCategory]> = [
  [".obsidian/app.json", "app"],
  [".obsidian/core-plugins.json", "corePlugins"],
  [".obsidian/community-plugins.json", "communityPlugins"],
  [".obsidian/plugins/calendar/main.js", "communityPlugins"],
  [".obsidian/plugins/calendar/data.json", "pluginSettings"],
  [".obsidian/themes/Theme/theme.css", "themesSnippets"],
];

describe("config sync category resolution", () => {
  it("classifies every user-facing config category", () => {
    for (const [path, category] of expectedCategoryExamples) {
      expect(categorizeConfigPath(path)).toBe(category);
    }
  });

  it("treats device-local categories as excluded from common config sync", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      configSync: { ...DEFAULT_SETTINGS.configSync, pluginSettings: "local" as const },
    };

    expect(shouldApplyConfigPath(".obsidian/plugins/calendar/data.json", settings)).toMatchObject({
      category: "pluginSettings",
      mode: "local",
      applies: false,
      reason: "category local",
    });
    expect(localConfigIgnorePatterns(settings)).toContain(".obsidian/plugins/*/data.json");
  });

  it("keeps common categories applicable while rejecting non-config files", () => {
    expect(shouldApplyConfigPath(".obsidian/app.json", DEFAULT_SETTINGS)).toMatchObject({ category: "app", mode: "common", applies: true });
    expect(shouldApplyConfigPath("notes/today.md", DEFAULT_SETTINGS)).toMatchObject({ category: null, applies: false, reason: "not config" });
  });
});
