/**
 * Client-side vault content encryption for Layer 1 blobs.
 *
 * AES-256-GCM is provided by WebCrypto. Nonces are deterministically derived
 * from HMAC-SHA-256(vault signing key, plaintext), making encryption convergent
 * so identical plaintext under the same vault key produces identical stored bytes.
 */

export const ENCRYPTED_BLOB_FORMAT_VERSION = 1;
export const ENCRYPTED_BLOB_ALGORITHM = 'aes-256-gcm-pbkdf2-sha256-convergent-v1';
export const PBKDF2_ITERATIONS = 310_000;
export const ENCRYPTION_SALT_BYTES = 16;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;

const MAGIC = new Uint8Array([0x4f, 0x53, 0x45, 0x4e, 0x43]); // OSENC
const HEADER_BYTES = MAGIC.byteLength + 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES;
const VERIFIER_TEXT = 'obsidian-sync:vault-content-encryption-verifier:v1';

type BufferLike = { from(data: string, encoding: 'base64'): Uint8Array; from(data: Uint8Array): { toString(encoding: 'base64'): string } };

function getBuffer(): BufferLike | undefined {
  return (globalThis as { Buffer?: BufferLike }).Buffer;
}

export interface VaultContentKey {
  readonly algorithm: typeof ENCRYPTED_BLOB_ALGORITHM;
  readonly aesKey: CryptoKey;
  readonly hmacKey: CryptoKey;
}

export interface EncryptedBlobParts {
  readonly version: typeof ENCRYPTED_BLOB_FORMAT_VERSION;
  readonly algorithm: typeof ENCRYPTED_BLOB_ALGORITHM;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

export interface ContentEncryptionEncoding {
  readonly algorithm: typeof ENCRYPTED_BLOB_ALGORITHM;
  readonly version: typeof ENCRYPTED_BLOB_FORMAT_VERSION;
}

export const CONTENT_ENCRYPTION_ENCODING: ContentEncryptionEncoding = {
  algorithm: ENCRYPTED_BLOB_ALGORITHM,
  version: ENCRYPTED_BLOB_FORMAT_VERSION,
};

function getSubtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  return crypto.subtle;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function randomEncryptionSalt(): Uint8Array {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.getRandomValues) throw new Error('Web Crypto getRandomValues is not available in this environment');
  const salt = new Uint8Array(ENCRYPTION_SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const buffer = getBuffer();
  if (buffer) return buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const buffer = getBuffer();
  if (buffer) return new Uint8Array(buffer.from(value, 'base64'));
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function deriveVaultContentKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<VaultContentKey> {
  if (!passphrase) throw new Error('Encryption passphrase is required');
  if (salt.byteLength < ENCRYPTION_SALT_BYTES) throw new Error(`Encryption salt must be at least ${ENCRYPTION_SALT_BYTES} bytes`);
  const subtle = getSubtle();
  const passphraseKey = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: copyBuffer(salt), iterations, hash: 'SHA-256' }, passphraseKey, 512);
  const material = new Uint8Array(bits);
  const aesMaterial = material.slice(0, 32);
  const hmacMaterial = material.slice(32, 64);
  material.fill(0);
  const [aesKey, hmacKey] = await Promise.all([
    subtle.importKey('raw', aesMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    subtle.importKey('raw', hmacMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  ]);
  aesMaterial.fill(0);
  hmacMaterial.fill(0);
  return { algorithm: ENCRYPTED_BLOB_ALGORITHM, aesKey, hmacKey };
}

export async function encryptVaultBytes(plaintext: Uint8Array, key: VaultContentKey): Promise<EncryptedBlobParts> {
  const subtle = getSubtle();
  const signature = new Uint8Array(await subtle.sign('HMAC', key.hmacKey, copyBuffer(plaintext)));
  const nonce = signature.slice(0, GCM_NONCE_BYTES);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: copyBuffer(nonce), tagLength: GCM_TAG_BYTES * 8 }, key.aesKey, copyBuffer(plaintext)));
  return {
    version: ENCRYPTED_BLOB_FORMAT_VERSION,
    algorithm: ENCRYPTED_BLOB_ALGORITHM,
    nonce,
    ciphertext: sealed.slice(0, sealed.byteLength - GCM_TAG_BYTES),
    tag: sealed.slice(sealed.byteLength - GCM_TAG_BYTES),
  };
}

export function serializeEncryptedBlob(parts: EncryptedBlobParts): Uint8Array {
  if (parts.version !== ENCRYPTED_BLOB_FORMAT_VERSION || parts.algorithm !== ENCRYPTED_BLOB_ALGORITHM) throw new Error('Unsupported encrypted blob format');
  if (parts.nonce.byteLength !== GCM_NONCE_BYTES) throw new Error('Invalid encrypted blob nonce length');
  if (parts.tag.byteLength !== GCM_TAG_BYTES) throw new Error('Invalid encrypted blob tag length');
  return concatBytes([MAGIC, new Uint8Array([parts.version]), parts.nonce, parts.tag, parts.ciphertext]);
}

export function isEncryptedBlobEnvelope(bytes: Uint8Array): boolean {
  if (bytes.byteLength < HEADER_BYTES) return false;
  for (let i = 0; i < MAGIC.byteLength; i += 1) if (bytes[i] !== MAGIC[i]) return false;
  return bytes[MAGIC.byteLength] === ENCRYPTED_BLOB_FORMAT_VERSION;
}

export function parseEncryptedBlob(bytes: Uint8Array): EncryptedBlobParts {
  if (!isEncryptedBlobEnvelope(bytes)) throw new Error('Unsupported or invalid encrypted blob envelope');
  const nonceStart = MAGIC.byteLength + 1;
  const tagStart = nonceStart + GCM_NONCE_BYTES;
  const ciphertextStart = tagStart + GCM_TAG_BYTES;
  return {
    version: ENCRYPTED_BLOB_FORMAT_VERSION,
    algorithm: ENCRYPTED_BLOB_ALGORITHM,
    nonce: bytes.slice(nonceStart, tagStart),
    tag: bytes.slice(tagStart, ciphertextStart),
    ciphertext: bytes.slice(ciphertextStart),
  };
}

export async function decryptVaultBytes(envelope: Uint8Array, key: VaultContentKey): Promise<Uint8Array> {
  const parts = parseEncryptedBlob(envelope);
  const sealed = concatBytes([parts.ciphertext, parts.tag]);
  return new Uint8Array(await getSubtle().decrypt({ name: 'AES-GCM', iv: copyBuffer(parts.nonce), tagLength: GCM_TAG_BYTES * 8 }, key.aesKey, copyBuffer(sealed)));
}

export async function createEncryptionVerifier(passphrase: string, salt: Uint8Array): Promise<string> {
  const key = await deriveVaultContentKey(passphrase, salt);
  const envelope = serializeEncryptedBlob(await encryptVaultBytes(new TextEncoder().encode(VERIFIER_TEXT), key));
  return bytesToBase64(envelope);
}

export async function verifyEncryptionPassphrase(passphrase: string, salt: Uint8Array, verifierBase64: string): Promise<boolean> {
  try {
    const key = await deriveVaultContentKey(passphrase, salt);
    const plaintext = await decryptVaultBytes(base64ToBytes(verifierBase64), key);
    return constantTimeEqual(plaintext, new TextEncoder().encode(VERIFIER_TEXT));
  } catch {
    return false;
  }
}
