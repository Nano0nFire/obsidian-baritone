import { describe, expect, it } from "vitest";
import { canonicalVaultPath, isSyncablePath } from "../pathing.js";

describe("pathing", () => {
  it("normalizes paths and rejects unsafe or non-syncable paths", () => {
    expect(canonicalVaultPath("/A//B.md")).toBe("A/B.md");
    expect(isSyncablePath("notes/a.md")).toBe(true);
    expect(isSyncablePath("CON.md")).toBe(false);
    expect(isSyncablePath(".git/config")).toBe(false);
  });
});
