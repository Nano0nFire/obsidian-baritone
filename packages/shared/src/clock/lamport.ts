/**
 * Lamport-clock LWW (last-writer-wins) register used for path (rename) resolution.
 * A rename carries {lamport, deviceId}. The larger lamport wins; ties broken by
 * deviceId string comparison. This guarantees a deterministic total order across
 * all devices without losing data (the loser's path is simply not applied).
 */
export interface PathClock {
  readonly lamport: number;
  readonly deviceId: string;
}

/**
 * Compute the next Lamport timestamp for a local event given the highest
 * Lamport value observed so far. Lamport rule: local = max(seen) + 1.
 */
export function nextLamport(observedMax: number): number {
  return observedMax + 1;
}

export function makePathClock(lamport: number, deviceId: string): PathClock {
  return { lamport, deviceId };
}

/**
 * Returns > 0 if `a` wins over `b`, < 0 if `b` wins, 0 if identical.
 * Larger lamport wins; tie-break by larger deviceId (lexicographic).
 */
export function comparePathClock(a: PathClock, b: PathClock): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId > b.deviceId ? 1 : -1;
}

/** True if `candidate` should win over `current` (strictly greater in LWW order). */
export function pathClockWins(candidate: PathClock, current: PathClock): boolean {
  return comparePathClock(candidate, current) > 0;
}

/**
 * Merge a remote path clock into the local observed maximum so that future
 * local renames produce a strictly larger Lamport value.
 */
export function observeLamport(observedMax: number, incoming: PathClock): number {
  return Math.max(observedMax, incoming.lamport);
}
