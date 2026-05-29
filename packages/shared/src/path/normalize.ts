/**
 * Path normalization and validation (spec-core-protocol §S2).
 *
 * Canonical storage form for all vault-relative paths:
 *  - Unicode NFC
 *  - forward-slash `/` separators
 *  - no leading slash, no trailing slash
 *  - no `.` / `..` segments
 *
 * A separate case-folded form (`path_normalized`) is used to detect case-only
 * collisions across platforms with differing case sensitivity.
 */

export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_BYTES = 1024;

// Windows reserved device names (case-insensitive, with or without extension).
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Characters illegal on Windows / problematic cross-platform.
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"\\|?*\u0000-\u001f]/;

export class PathValidationError extends Error {
  constructor(
    public readonly reason: string,
    public readonly path: string,
  ) {
    super(`Invalid path "${path}": ${reason}`);
    this.name = 'PathValidationError';
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Normalize a raw path into canonical storage form.
 * Throws PathValidationError if the path cannot be represented safely.
 */
export function normalizePath(raw: string): string {
  if (typeof raw !== 'string') throw new PathValidationError('not a string', String(raw));

  // Unify separators, apply NFC.
  let p = raw.normalize('NFC').replace(/\\/g, '/');

  // Collapse repeated slashes, trim leading/trailing slashes.
  p = p.replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

  if (p.length === 0) throw new PathValidationError('empty path', raw);
  if (byteLength(p) > MAX_PATH_BYTES) throw new PathValidationError('path too long', raw);

  const segments = p.split('/');
  for (const seg of segments) {
    validateSegment(seg, raw);
  }
  return p;
}

function validateSegment(seg: string, raw: string): void {
  if (seg.length === 0) throw new PathValidationError('empty segment', raw);
  if (seg === '.' || seg === '..') throw new PathValidationError('dot segment', raw);
  if (byteLength(seg) > MAX_SEGMENT_BYTES) throw new PathValidationError('segment too long', raw);
  if (ILLEGAL_CHARS.test(seg)) throw new PathValidationError('illegal character', raw);
  // Trailing space or dot is invalid on Windows.
  if (/[ .]$/.test(seg)) throw new PathValidationError('trailing space or dot', raw);
  // Reserved device name (with or without extension).
  const base = (seg.split('.')[0] ?? '').toLowerCase();
  if (WINDOWS_RESERVED.has(base)) throw new PathValidationError('reserved name', raw);
}

/** True if `raw` is a valid path without throwing. */
export function isValidPath(raw: string): boolean {
  try {
    normalizePath(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Case-folded, accent-preserving key for collision detection.
 * Input must already be a canonical (normalizePath) path.
 */
export function caseFoldPath(canonicalPath: string): string {
  return canonicalPath.toLowerCase();
}

/** Split a canonical path into [parentDir, baseName]. parentDir is '' for root-level. */
export function splitPath(canonicalPath: string): [string, string] {
  const idx = canonicalPath.lastIndexOf('/');
  if (idx < 0) return ['', canonicalPath];
  return [canonicalPath.slice(0, idx), canonicalPath.slice(idx + 1)];
}

/** Join a parent dir and a base name into a canonical path. */
export function joinPath(parentDir: string, baseName: string): string {
  return parentDir ? `${parentDir}/${baseName}` : baseName;
}

/** The file extension including the leading dot, or '' if none. */
export function extname(canonicalPath: string): string {
  const [, base] = splitPath(canonicalPath);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx);
}

/**
 * Produce a de-duplicated path by inserting a numeric suffix before the
 * extension, e.g. `notes/a.md` -> `notes/a (2).md`. Used for create×create and
 * rename collisions.
 */
export function suffixPath(canonicalPath: string, n: number): string {
  const [dir, base] = splitPath(canonicalPath);
  const ext = extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  return joinPath(dir, `${stem} (${n})${ext}`);
}
