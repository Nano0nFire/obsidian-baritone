import { caseFoldPath, type FileType, type VersionVector } from "@obsidian-sync/shared";

/** A syncable local file as seen by a force operation. */
export interface LocalFileSnapshot {
  path: string;
  /** Storage hash, exactly as the server would store it (post-encryption). */
  hash: string;
  type: FileType;
  /** Local index fileId, when the file is already tracked. */
  fileId?: string;
}

/** A live remote file (subset of ManifestEntry) used to plan force operations. */
export interface RemoteFileSnapshot {
  fileId: string;
  path: string;
  contentHash: string | null;
  contentVV: VersionVector;
  type: FileType;
}

export type ForcePushAction =
  | { kind: "content"; mode: "create" | "update"; fileId: string; path: string; type: FileType; dominateVV: VersionVector }
  | { kind: "delete"; fileId: string; path: string; type: FileType };

export interface ForcePushAdoption {
  path: string;
  oldFileId?: string;
  newFileId: string;
}

export interface ForcePushPlan {
  actions: ForcePushAction[];
  /** Local index fixups: paths whose fileId must be re-pointed at the adopted remote fileId. */
  adoptions: ForcePushAdoption[];
}

/**
 * Plan the operations required to make the remote vault state identical to the
 * local vault: create/overwrite every local file and delete remote-only files.
 *
 * Content updates carry the remote file's current contentVV as the vector to
 * dominate so the caller can construct an op that cleanly overwrites (rather
 * than conflicts with) the stored version.
 */
export function planForcePush(
  local: readonly LocalFileSnapshot[],
  remote: readonly RemoteFileSnapshot[],
  newFileId: () => string,
): ForcePushPlan {
  const remoteByPath = new Map<string, RemoteFileSnapshot>();
  const remoteFileIds = new Set<string>();
  for (const entry of remote) {
    remoteByPath.set(caseFoldPath(entry.path), entry);
    remoteFileIds.add(entry.fileId);
  }
  const localPaths = new Set(local.map((file) => caseFoldPath(file.path)));

  const actions: ForcePushAction[] = [];
  const adoptions: ForcePushAdoption[] = [];

  for (const file of local) {
    const match = remoteByPath.get(caseFoldPath(file.path));
    if (match) {
      if (file.fileId !== match.fileId) adoptions.push({ path: file.path, oldFileId: file.fileId, newFileId: match.fileId });
      if (match.contentHash === file.hash) continue;
      actions.push({ kind: "content", mode: "update", fileId: match.fileId, path: file.path, type: file.type, dominateVV: { ...match.contentVV } });
      continue;
    }
    const fileId = file.fileId && !remoteFileIds.has(file.fileId) ? file.fileId : newFileId();
    actions.push({ kind: "content", mode: "create", fileId, path: file.path, type: file.type, dominateVV: {} });
  }

  for (const entry of remote) {
    if (!localPaths.has(caseFoldPath(entry.path))) actions.push({ kind: "delete", fileId: entry.fileId, path: entry.path, type: entry.type });
  }

  return { actions, adoptions };
}

/**
 * Compute the local paths that must be removed so the local vault mirrors the
 * remote: any syncable local path that is not present in the live remote
 * manifest. Callers MUST pass only paths within sync scope (ignore-filtered).
 */
export function planForcePullStrays(localPaths: readonly string[], remote: readonly RemoteFileSnapshot[]): string[] {
  const remotePaths = new Set(remote.map((entry) => caseFoldPath(entry.path)));
  return localPaths.filter((path) => !remotePaths.has(caseFoldPath(path)));
}
