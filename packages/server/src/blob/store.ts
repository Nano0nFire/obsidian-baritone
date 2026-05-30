import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ErrorCode, hashBytes, isValidContentHash, SyncError } from '@obsidian-sync/shared';
import type { BlobRecord, OpDataStore } from '../engine/store.js';

export interface BlobStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export class BlobStore {
  private readonly s3: S3Client;
  constructor(private readonly config: BlobStoreConfig, private readonly data: OpDataStore) {
    this.s3 = new S3Client({ endpoint: config.endpoint, region: config.region, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, forcePathStyle: true });
  }

  async initUpload(hash: string, size: number): Promise<{ hash: string; url: string | null; alreadyExists: boolean }> {
    validateHashAndSize(hash, size);
    const existing = await this.data.getBlob(hash);
    if (existing?.state === 'verified') return { hash, url: null, alreadyExists: true };
    const blob: BlobRecord = existing ?? { hash, size, objectKey: this.objectKey(hash), state: 'pending', createdAt: new Date(), verifiedAt: null, unreferencedAt: null, deletedAt: null };
    if (blob.size !== size) throw new SyncError(ErrorCode.BLOB_HASH_MISMATCH, 'Hash already registered with different size');
    await this.data.saveBlob({ ...blob, state: 'pending' });
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.config.bucket, Key: blob.objectKey, ContentLength: size }), { expiresIn: 900 });
    return { hash, url, alreadyExists: false };
  }

  async completeUpload(hash: string): Promise<BlobRecord> {
    if (!isValidContentHash(hash)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid hash');
    const blob = await this.data.getBlob(hash);
    if (!blob) throw new SyncError(ErrorCode.BLOB_MISSING, 'Upload was not initialized');
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: blob.objectKey }));
    const size = Number(head.ContentLength ?? -1);
    if (size !== blob.size) throw new SyncError(ErrorCode.BLOB_HASH_MISMATCH, 'Uploaded object size mismatch');
    const actualHash = await this.hashRemoteObject(blob.objectKey);
    if (actualHash !== hash) throw new SyncError(ErrorCode.BLOB_HASH_MISMATCH, 'Uploaded object hash mismatch');
    const verified = { ...blob, state: 'verified' as const, verifiedAt: new Date(), unreferencedAt: null };
    await this.data.saveBlob(verified);
    return verified;
  }

  async verifyBytes(hash: string, bytes: Uint8Array): Promise<void> {
    if ((await hashBytes(bytes)) !== hash) throw new SyncError(ErrorCode.BLOB_HASH_MISMATCH, 'Blob hash mismatch');
  }

  async getBytes(hash: string): Promise<Uint8Array | null> {
    if (!isValidContentHash(hash)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid hash');
    const blob = await this.data.getBlob(hash);
    if (!blob || blob.state !== 'verified') return null;
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: blob.objectKey }));
    if (!response.Body || typeof (response.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await this.verifyBytes(hash, bytes);
    return bytes;
  }

  async gcUnreferenced(minAgeMs: number, now = new Date()): Promise<string[]> {
    const removed: string[] = [];
    const data = this.data as unknown as { blobs?: Map<string, BlobRecord> };
    if (!data.blobs) return removed;
    for (const blob of data.blobs.values()) {
      const refs = await this.data.listBlobRefs(blob.hash);
      if (refs.length > 0 || blob.state === 'deleted') continue;
      const markTime = blob.unreferencedAt ?? now;
      if (!blob.unreferencedAt) await this.data.saveBlob({ ...blob, state: 'unreferenced', unreferencedAt: markTime });
      else if (now.getTime() - markTime.getTime() >= minAgeMs) {
        await this.data.saveBlob({ ...blob, state: 'deleted', deletedAt: now });
        removed.push(blob.hash);
      }
    }
    return removed;
  }

  private async hashRemoteObject(objectKey: string): Promise<string> {
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    if (!response.Body || typeof (response.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') throw new SyncError(ErrorCode.BLOB_MISSING, 'Uploaded object body is unavailable');
    const hash = createHash('sha256');
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
  }

  private objectKey(hash: string): string {
    return `blobs/${hash.slice(7, 9)}/${hash.slice(9, 11)}/${hash.slice(7)}`;
  }
}

function validateHashAndSize(hash: string, size: number): void {
  if (!isValidContentHash(hash)) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid content hash');
  if (!Number.isSafeInteger(size) || size < 0) throw new SyncError(ErrorCode.BAD_REQUEST, 'Invalid blob size');
}
