export interface IndexedFileSnapshot {
  fileId: string;
  path: string;
  contentHash: string | null;
  mtime: number;
  size: number;
}

export interface DiskFileSnapshot {
  path: string;
  contentHash: string;
  mtime: number;
  size: number;
}

export interface ReconciliationPlan {
  creates: DiskFileSnapshot[];
  updates: Array<{ indexed: IndexedFileSnapshot; disk: DiskFileSnapshot }>;
  deletes: IndexedFileSnapshot[];
  renames: Array<{ fileId: string; oldPath: string; newPath: string; contentHash: string }>;
}

export function planReconciliation(input: {
  indexed: readonly IndexedFileSnapshot[];
  disk: readonly DiskFileSnapshot[];
}): ReconciliationPlan {
  const indexedByPath = new Map(input.indexed.map((entry) => [entry.path, entry]));
  const diskByPath = new Map(input.disk.map((entry) => [entry.path, entry]));
  const missing = input.indexed.filter((entry) => !diskByPath.has(entry.path));
  const appearing = input.disk.filter((entry) => !indexedByPath.has(entry.path));
  const renames: ReconciliationPlan["renames"] = [];
  const consumedMissing = new Set<string>();
  const consumedAppearing = new Set<string>();
  const missingByHash = new Map<string, IndexedFileSnapshot[]>();
  for (const item of missing) {
    if (!item.contentHash) continue;
    const bucket = missingByHash.get(item.contentHash) ?? [];
    bucket.push(item);
    missingByHash.set(item.contentHash, bucket);
  }
  for (const candidate of appearing) {
    const matches = missingByHash.get(candidate.contentHash) ?? [];
    const match = matches.find((entry) => !consumedMissing.has(entry.path));
    if (!match) continue;
    consumedMissing.add(match.path);
    consumedAppearing.add(candidate.path);
    renames.push({ fileId: match.fileId, oldPath: match.path, newPath: candidate.path, contentHash: candidate.contentHash });
  }
  const creates = appearing.filter((entry) => !consumedAppearing.has(entry.path));
  const deletes = missing.filter((entry) => !consumedMissing.has(entry.path));
  const updates = input.disk
    .filter((disk) => indexedByPath.has(disk.path))
    .map((disk) => ({ indexed: indexedByPath.get(disk.path) as IndexedFileSnapshot, disk }))
    .filter(({ indexed, disk }) => indexed.contentHash !== disk.contentHash || indexed.size !== disk.size);
  return { creates, updates, deletes, renames };
}
