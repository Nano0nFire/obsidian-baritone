#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const semverCore = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * Normalize a git tag to the semantic version it represents.
 * Accepts bare semver ("0.1.0"), a leading "v" ("v0.1.0") and prerelease
 * suffixes ("v0.2.0-beta.1"). Throws if the tag contains no semver core.
 */
export function normalizeTag(tag) {
  if (typeof tag !== "string" || tag.trim() === "") {
    throw new Error("A release tag is required");
  }
  const trimmed = tag.trim().replace(/^v/i, "");
  const match = trimmed.match(semverCore);
  if (!match || match[0] !== trimmed) {
    throw new Error(`Tag "${tag}" is not a semantic version like 1.2.3`);
  }
  return trimmed;
}

/**
 * Assert that the release tag matches the plugin manifest version. BRAT selects
 * the release with the highest version and trusts the tag, so a mismatch would
 * publish a release that misrepresents the bundled manifest.
 */
export function assertTagMatchesManifest(tag, manifestVersion) {
  const normalized = normalizeTag(tag);
  if (normalized !== manifestVersion) {
    throw new Error(
      `Release tag "${tag}" (=> ${normalized}) does not match manifest version "${manifestVersion}". ` +
        `Run "npm run version-bump --workspace obsidian-sync-plugin <version>" and tag the same version.`,
    );
  }
  return normalized;
}

async function main() {
  const tag = process.argv[2];
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, "manifest.json"), "utf8"),
  );
  const version = assertTagMatchesManifest(tag, manifest.version);
  console.log(`Release tag matches manifest version ${version}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
