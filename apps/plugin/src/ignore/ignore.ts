import { normalizePath } from "@obsidian-sync/shared";

export const DEFAULT_IGNORE_PATTERNS = [
  ".obsidian/workspace*.json",
  ".trash/",
  ".git/",
  ".DS_Store",
  "**/.DS_Store",
];

export interface IgnoreLayers {
  common: readonly string[];
  local: readonly string[];
}

interface Rule {
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

function escapeRegex(input: string): string {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string, directoryOnly: boolean): RegExp {
  let p = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  if (directoryOnly) p = p.replace(/\/+$/, "");
  const anchored = p.includes("/");
  let out = "";
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    const next = p[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch ?? "");
    }
  }
  const prefix = anchored ? "^" : "(^|.*/)";
  const suffix = directoryOnly ? "(/.*)?$" : "$";
  return new RegExp(`${prefix}${out}${suffix}`);
}

function parseRule(raw: string): Rule | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const negated = trimmed.startsWith("!");
  const body = negated ? trimmed.slice(1) : trimmed;
  if (!body) return null;
  const directoryOnly = body.endsWith("/");
  return { negated, directoryOnly, regex: globToRegex(body, directoryOnly) };
}

export class SyncIgnore {
  private readonly rules: Rule[];

  constructor(layers: Partial<IgnoreLayers> = {}) {
    this.rules = [...DEFAULT_IGNORE_PATTERNS, ...(layers.common ?? []), ...(layers.local ?? [])]
      .map(parseRule)
      .filter((rule): rule is Rule => rule !== null);
  }

  ignores(rawPath: string): boolean {
    let path: string;
    try {
      path = normalizePath(rawPath);
    } catch {
      return true;
    }
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(path)) ignored = !rule.negated;
    }
    return ignored;
  }

  filter(paths: readonly string[]): string[] {
    return paths.filter((path) => !this.ignores(path));
  }
}
