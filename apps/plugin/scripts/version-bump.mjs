#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const result = { dir: pluginRoot, version: undefined, minAppVersion: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") {
      const value = argv[i + 1];
      if (!value) throw new Error("--dir requires a path");
      result.dir = value;
      i += 1;
    } else if (arg === "--min-app-version") {
      const value = argv[i + 1];
      if (!value) throw new Error("--min-app-version requires a value");
      result.minAppVersion = value;
      i += 1;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!result.version) {
      result.version = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return result;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assertVersion(version, label) {
  if (typeof version !== "string" || !semverPattern.test(version)) {
    throw new Error(`${label} must be a semantic version like 1.2.3`);
  }
}

export async function syncVersionFiles(options = {}) {
  const dir = options.dir ?? pluginRoot;
  const packagePath = join(dir, "package.json");
  const manifestPath = join(dir, "manifest.json");
  const versionsPath = join(dir, "versions.json");

  const [pkg, manifest, versions] = await Promise.all([
    readJson(packagePath),
    readJson(manifestPath),
    readJson(versionsPath).catch((error) => {
      if (error && error.code === "ENOENT") return {};
      throw error;
    }),
  ]);

  const version = options.version ?? pkg.version;
  const minAppVersion = options.minAppVersion ?? manifest.minAppVersion;
  assertVersion(version, "version");
  assertVersion(minAppVersion, "minAppVersion");

  const nextPackage = { ...pkg, version };
  const nextManifest = { ...manifest, version, minAppVersion };
  const nextVersions = { ...versions, [version]: minAppVersion };

  await writeJson(packagePath, nextPackage);
  await writeJson(manifestPath, nextManifest);
  await writeJson(versionsPath, nextVersions);
  return { version, minAppVersion };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await syncVersionFiles(args);
    console.log(`Synced plugin version ${result.version} (minAppVersion ${result.minAppVersion})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
