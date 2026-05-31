import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM helper without type declarations (kept outside tsc include)
import { normalizeTag, assertTagMatchesManifest } from "./verify-release-version.mjs";

describe("normalizeTag", () => {
  it("returns a bare semver unchanged", () => {
    expect(normalizeTag("0.1.0")).toBe("0.1.0");
  });

  it("strips a leading v prefix", () => {
    expect(normalizeTag("v1.2.3")).toBe("1.2.3");
  });

  it("preserves a prerelease suffix", () => {
    expect(normalizeTag("v0.2.0-beta.1")).toBe("0.2.0-beta.1");
  });

  it("throws on a tag without a semver core", () => {
    expect(() => normalizeTag("latest")).toThrow();
  });
});

describe("assertTagMatchesManifest", () => {
  it("passes when tag equals manifest version", () => {
    expect(() => assertTagMatchesManifest("0.1.0", "0.1.0")).not.toThrow();
  });

  it("passes when tag has a v prefix but matches", () => {
    expect(() => assertTagMatchesManifest("v0.1.0", "0.1.0")).not.toThrow();
  });

  it("throws when tag does not match manifest version", () => {
    expect(() => assertTagMatchesManifest("0.2.0", "0.1.0")).toThrow(
      /does not match/i,
    );
  });
});
