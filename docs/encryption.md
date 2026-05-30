# Vault content encryption

Vault content encryption is opt-in and off by default. When enabled, clients encrypt Layer 1 file bytes before upload; the server stores and hashes only the encrypted envelope bytes.

## Threat model

Protected:
- Layer 1 note/config/attachment contents at rest on the sync server and object store.
- Blob integrity remains server-verifiable because content hashes are computed over the stored encrypted envelope bytes.

Not protected:
- Vault IDs, device IDs, file IDs, paths, file types, ciphertext sizes, operation timing, access patterns, and conflict metadata.
- Realtime Layer 2 collaborative editing. The server must read plaintext to seed and merge Yjs documents, so Layer 2 is automatically disabled while vault content encryption is enabled.
- Plaintext already uploaded before enabling encryption. Enabling or disabling affects new writes; a full migration requires re-uploading/reconciling all files.

## Crypto and key handling

- KDF: PBKDF2-HMAC-SHA-256 via `globalThis.crypto.subtle`, 310,000 iterations, 16-byte per-vault random salt.
- Derived material: 512 bits split into an AES-256-GCM key and an HMAC-SHA-256 key.
- Salt and encrypted verifier are stored locally in plugin settings. The passphrase and derived key are never sent to the server; the passphrase is not persisted.
- Encryption format: versioned `OSENC` envelope containing format version, 96-bit nonce, 128-bit GCM tag, and ciphertext.

## Hashing and deduplication

The server verifies blob uploads by recomputing SHA-256 over the stored bytes (`BlobStore.completeUpload`). Therefore encrypted clients use convergent encryption: the AES-GCM nonce is deterministically derived as `HMAC-SHA-256(vault-key, plaintext)[0..12)`. Identical plaintext under the same vault key produces identical ciphertext and a stable `sha256:` content hash, preserving Layer 1 deduplication and avoiding spurious local diffs.

Trade-off: convergent encryption reveals plaintext equality within the same keyed vault. It does not let the server decrypt content.

## Layer 2 interaction

When vault content encryption is enabled, clients do not send `promote` and the server rejects promote attempts for files marked with encrypted content metadata. Layer 1 sync continues to work with encrypted blobs.
