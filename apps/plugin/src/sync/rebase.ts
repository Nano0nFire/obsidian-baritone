import { bump, compareVV, type VersionVector } from "@obsidian-sync/shared";

export type RebaseResult =
  | { ok: true; base: VersionVector; next: VersionVector }
  | { ok: false; reason: "concurrent" | "already-applied" };

export function rebaseContentDraft(localBase: VersionVector, remoteCurrent: VersionVector, deviceId: string): RebaseResult {
  const relation = compareVV(remoteCurrent, localBase);
  if (relation === "concurrent") return { ok: false, reason: "concurrent" };
  if (relation === "equal" || relation === "dominates") return { ok: true, base: remoteCurrent, next: bump(remoteCurrent, deviceId) };
  return { ok: false, reason: "already-applied" };
}
