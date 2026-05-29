/**
 * Version Vector (VV) for tracking content causality per file.
 * Map of deviceId -> monotonically increasing counter.
 *
 * Used to determine causal relationships between two versions of a file's content:
 * - dominates: A has seen everything B has seen (and possibly more)
 * - concurrent: neither dominates the other (a real conflict)
 */
export type VersionVector = Readonly<Record<string, number>>;

export const EMPTY_VV: VersionVector = Object.freeze({});

/** Returns a copy with `deviceId`'s counter incremented (bumped) by 1. */
export function bump(vv: VersionVector, deviceId: string): VersionVector {
  return { ...vv, [deviceId]: (vv[deviceId] ?? 0) + 1 };
}

/** Returns the counter for a device (0 if absent). */
export function counterFor(vv: VersionVector, deviceId: string): number {
  return vv[deviceId] ?? 0;
}

/** Pointwise maximum (least upper bound / join) of two version vectors. */
export function join(a: VersionVector, b: VersionVector): VersionVector {
  const result: Record<string, number> = { ...a };
  for (const [device, counter] of Object.entries(b)) {
    const existing = result[device] ?? 0;
    if (counter > existing) result[device] = counter;
  }
  return result;
}

/**
 * True if `a` dominates `b`: for every device, a[d] >= b[d].
 * (a has causally observed everything in b.)
 */
export function dominates(a: VersionVector, b: VersionVector): boolean {
  for (const [device, counter] of Object.entries(b)) {
    if ((a[device] ?? 0) < counter) return false;
  }
  return true;
}

/** True if a and b are exactly equal. */
export function equals(a: VersionVector, b: VersionVector): boolean {
  return dominates(a, b) && dominates(b, a);
}

/** True if a strictly dominates b (dominates and not equal). */
export function strictlyDominates(a: VersionVector, b: VersionVector): boolean {
  return dominates(a, b) && !dominates(b, a);
}

/**
 * True if a and b are concurrent: neither dominates the other.
 * Concurrent content versions represent a genuine conflict.
 */
export function isConcurrent(a: VersionVector, b: VersionVector): boolean {
  return !dominates(a, b) && !dominates(b, a);
}

export type VVRelation = 'equal' | 'dominates' | 'dominated' | 'concurrent';

/** Classify the causal relationship of `a` relative to `b`. */
export function compareVV(a: VersionVector, b: VersionVector): VVRelation {
  const aDomB = dominates(a, b);
  const bDomA = dominates(b, a);
  if (aDomB && bDomA) return 'equal';
  if (aDomB) return 'dominates';
  if (bDomA) return 'dominated';
  return 'concurrent';
}

/** Serialize a VV to a stable, canonical JSON string (sorted keys). */
export function serializeVV(vv: VersionVector): string {
  const sorted = Object.keys(vv)
    .filter((k) => (vv[k] ?? 0) !== 0)
    .sort();
  const obj: Record<string, number> = {};
  for (const k of sorted) obj[k] = vv[k] as number;
  return JSON.stringify(obj);
}

export function parseVV(json: string): VersionVector {
  const parsed = JSON.parse(json) as Record<string, number>;
  return parsed ?? {};
}
