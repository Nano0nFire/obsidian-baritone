import { normalizePath } from "@obsidian-sync/shared";
import { DEFAULT_IGNORE_PATTERNS, SyncIgnore } from "./ignore/ignore.js";

const defaultIgnore = new SyncIgnore({ common: DEFAULT_IGNORE_PATTERNS, local: [] });

export function canonicalVaultPath(raw: string): string {
  return normalizePath(raw);
}

export function isSyncablePath(raw: string, ignore = defaultIgnore): boolean {
  try {
    const path = canonicalVaultPath(raw);
    return !ignore.ignores(path);
  } catch {
    return false;
  }
}

export function isTextPath(path: string): boolean {
  return /\.(md|txt|json|css|csv|yaml|yml|xml|html|js|ts|canvas)$/i.test(path);
}
