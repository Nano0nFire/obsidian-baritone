import { describe, expect, it } from "vitest";
import { SyncIgnore } from "../ignore/ignore.js";

describe("SyncIgnore", () => {
  it("applies defaults, common rules, local rules, negation, and directory globs", () => {
    const ignore = new SyncIgnore({ common: ["build/", "*.secret", "!keep.secret"], local: ["local-only.md"] });
    expect(ignore.ignores(".trash/deleted.md")).toBe(true);
    expect(ignore.ignores(".git/config")).toBe(true);
    expect(ignore.ignores(".obsidian/workspace.json")).toBe(true);
    expect(ignore.ignores("build/out.md")).toBe(true);
    expect(ignore.ignores("notes/token.secret")).toBe(true);
    expect(ignore.ignores("keep.secret")).toBe(false);
    expect(ignore.ignores("local-only.md")).toBe(true);
    expect(ignore.ignores("notes/real.md")).toBe(false);
  });
});
