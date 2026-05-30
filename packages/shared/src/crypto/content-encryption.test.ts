import { describe, expect, it } from 'vitest';
import {
  createEncryptionVerifier,
  decryptVaultBytes,
  deriveVaultContentKey,
  encryptVaultBytes,
  ENCRYPTED_BLOB_FORMAT_VERSION,
  isEncryptedBlobEnvelope,
  randomEncryptionSalt,
  serializeEncryptedBlob,
  verifyEncryptionPassphrase,
} from './content-encryption';

const passphrase = 'correct horse battery staple';
const otherPassphrase = 'different passphrase';
const salt = new Uint8Array(Array.from({ length: 16 }, (_, i) => i + 1));
const plaintext = new TextEncoder().encode('hello encrypted vault 🌒');

describe('vault content encryption', () => {
  it('round-trips arbitrary bytes through the versioned AES-GCM envelope', async () => {
    const key = await deriveVaultContentKey(passphrase, salt);

    const encrypted = await encryptVaultBytes(plaintext, key);
    const envelope = serializeEncryptedBlob(encrypted);
    const decrypted = await decryptVaultBytes(envelope, key);

    expect(encrypted.version).toBe(ENCRYPTED_BLOB_FORMAT_VERSION);
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.tag).toHaveLength(16);
    expect(isEncryptedBlobEnvelope(envelope)).toBe(true);
    expect([...decrypted]).toEqual([...plaintext]);
  });

  it('uses convergent encryption for stable ciphertext and content hashes with the same vault key', async () => {
    const key = await deriveVaultContentKey(passphrase, salt);
    const first = serializeEncryptedBlob(await encryptVaultBytes(plaintext, key));
    const second = serializeEncryptedBlob(await encryptVaultBytes(plaintext, key));

    expect([...second]).toEqual([...first]);
  });

  it('produces different ciphertext for the same plaintext under a different key', async () => {
    const firstKey = await deriveVaultContentKey(passphrase, salt);
    const secondKey = await deriveVaultContentKey(otherPassphrase, salt);

    const first = serializeEncryptedBlob(await encryptVaultBytes(plaintext, firstKey));
    const second = serializeEncryptedBlob(await encryptVaultBytes(plaintext, secondKey));

    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(false);
  });

  it('rejects wrong passphrases via both decrypt and verifier checks', async () => {
    const key = await deriveVaultContentKey(passphrase, salt);
    const wrongKey = await deriveVaultContentKey(otherPassphrase, salt);
    const envelope = serializeEncryptedBlob(await encryptVaultBytes(plaintext, key));
    const verifier = await createEncryptionVerifier(passphrase, salt);

    await expect(decryptVaultBytes(envelope, wrongKey)).rejects.toThrow();
    await expect(verifyEncryptionPassphrase(passphrase, salt, verifier)).resolves.toBe(true);
    await expect(verifyEncryptionPassphrase(otherPassphrase, salt, verifier)).resolves.toBe(false);
  });

  it('creates random local salts without contacting the server', () => {
    const first = randomEncryptionSalt();
    const second = randomEncryptionSalt();

    expect(first).toHaveLength(16);
    expect(second).toHaveLength(16);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(false);
  });
});
