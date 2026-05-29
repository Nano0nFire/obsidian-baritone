/**
 * Content-addressed hashing (SHA-256) used for dedup and integrity verification.
 * Uses the Web Crypto API (globalThis.crypto.subtle), available in both modern
 * Node.js (>= 20) and browsers / Obsidian's Electron renderer.
 */

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += (HEX[b >> 4] as string) + (HEX[b & 0x0f] as string);
  }
  return out;
}

function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  }
  return c.subtle;
}

/** Hash raw bytes. Returns lowercase hex SHA-256 digest. */
export async function hashBytes(data: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so subtle.digest accepts it.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await getSubtle().digest('SHA-256', buf);
  return toHex(new Uint8Array(digest));
}

/** Hash a UTF-8 string. */
export async function hashText(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

/**
 * Content hash with a type prefix to avoid collisions between note text and
 * binary attachments that happen to share bytes. Format: `sha256:<hex>`.
 */
export async function contentHash(data: Uint8Array): Promise<string> {
  return `sha256:${await hashBytes(data)}`;
}

export async function contentHashText(text: string): Promise<string> {
  return `sha256:${await hashText(text)}`;
}

/** Validate that a string looks like a `sha256:<64-hex>` content hash. */
export function isValidContentHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
