import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const pluginRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const scriptPath = join(pluginRoot, "scripts/version-bump.mjs");
const workDir = join(pluginRoot, ".test-output/version-bump");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runVersionBump(args: string[]): void {
  execFileSync(process.execPath, [scriptPath, "--dir", workDir, ...args], { cwd: pluginRoot, stdio: "pipe" });
}

describe("version-bump script", () => {
  beforeEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    writeJson(join(workDir, "package.json"), { name: "obsidian-sync-plugin", version: "0.1.0" });
    writeJson(join(workDir, "manifest.json"), { id: "obsidian-sync", version: "0.0.1", minAppVersion: "1.6.0" });
    writeJson(join(workDir, "versions.json"), { "0.0.1": "1.5.0" });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("updates package, manifest, and versions map to the requested release version", () => {
    runVersionBump(["0.2.0", "--min-app-version", "1.7.0"]);

    expect(readJson(join(workDir, "package.json"))).toMatchObject({ version: "0.2.0" });
    expect(readJson(join(workDir, "manifest.json"))).toMatchObject({ version: "0.2.0", minAppVersion: "1.7.0" });
    expect(readJson(join(workDir, "versions.json"))).toEqual({ "0.0.1": "1.5.0", "0.2.0": "1.7.0" });
  });

  it("uses package version and manifest minAppVersion when no explicit values are provided", () => {
    runVersionBump([]);

    expect(readJson(join(workDir, "manifest.json"))).toMatchObject({ version: "0.1.0", minAppVersion: "1.6.0" });
    expect(readJson(join(workDir, "versions.json"))).toEqual({ "0.0.1": "1.5.0", "0.1.0": "1.6.0" });
  });
});
