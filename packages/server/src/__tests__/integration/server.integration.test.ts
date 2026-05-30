import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentHash, contentHashText, type FileOp, type ServerMessage } from '@obsidian-sync/shared';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../../blob/store.js';
import { migrate } from '../../db/migrate.js';
import { PgOpDataStore } from '../../db/pg-op-store.js';
import { PgDatabase } from '../../db/pool.js';
import { OpProcessor } from '../../engine/op-processor.js';
import { RoomManager, type RoomSink } from '../../engine/room-manager.js';
import { PgYjsRoomStore } from '../../engine/yjs.js';

const requiredEnv = ['DATABASE_URL', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;
const integrationReady = process.env.RUN_INTEGRATION === '1' && requiredEnv.every((key) => Boolean(process.env[key]));

const vaultId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const otherDeviceId = '44444444-4444-4444-8444-444444444444';
const fileId = '55555555-5555-4555-8555-555555555555';

class CapturingSink implements RoomSink {
  readonly messages: ServerMessage[] = [];
  constructor(readonly deviceId: string) {}
  send(message: ServerMessage): void { this.messages.push(message); }
}

describe.skipIf(!integrationReady)('server integration: postgres, minio, and Layer 2', () => {
  let db: PgDatabase;
  let data: PgOpDataStore;

  beforeEach(async () => {
    db = new PgDatabase(process.env.DATABASE_URL!);
    data = new PgOpDataStore(db);
    await resetDatabase(db);
  });

  afterEach(async () => {
    await db?.close();
  });

  it('runs migrations and records all versions idempotently', async () => {
    const expected = ['001_initial', '002_yjs_layer2', '003_snapshot_history', '004_content_encoding'];
    const first = await migrate(db);
    expect(first).toEqual(expected);

    const rows = (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows;
    expect(rows.map((row) => row.version)).toEqual(expected);

    await expect(migrate(db)).resolves.toEqual([]);
    const count = (await db.query<{ count: string }>('SELECT count(*) FROM schema_migrations')).rows[0]?.count;
    expect(Number(count)).toBe(expected.length);
  });

  it('round-trips PgOpDataStore ops, manifest, content, ordering, and conflicts', async () => {
    await migrate(db);
    await seedIdentity(db);
    const processor = new OpProcessor(data);

    const create = await noteOp({ kind: 'create', text: 'hello', deviceSeq: 1, newPath: 'A.md', vv: { [deviceId]: 1 } });
    const created = await processor.process(create, userId);
    expect(created.type).toBe('ack');

    const update = await noteOp({ kind: 'update', text: 'hello world', deviceSeq: 2, vv: { [deviceId]: 2 } });
    const updated = await processor.process(update, userId);
    expect(updated.type).toBe('ack');

    const concurrent = await noteOp({ kind: 'update', text: 'other edit', deviceId: otherDeviceId, deviceSeq: 1, vv: { [deviceId]: 1, [otherDeviceId]: 1 } });
    const conflicted = await processor.process(concurrent, userId);
    expect(conflicted.type).toBe('ack');
    expect(conflicted.type === 'ack' ? conflicted.conflictId : undefined).toBeTruthy();

    const ops = await data.listOps(vaultId, 0, 10);
    expect(ops.map((entry) => entry.vaultSeq)).toEqual([1, 2, 3]);
    expect(ops.map((entry) => entry.op.kind)).toEqual(['create', 'update', 'update']);

    const manifest = await data.listManifest(vaultId, null, 10);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]).toMatchObject({ fileId, path: 'A.md', contentVV: { [deviceId]: 2 }, deleted: false });

    const file = await data.getFile(vaultId, fileId);
    expect(file?.conflictId).toBe(conflicted.type === 'ack' ? conflicted.conflictId : undefined);
    expect(new TextDecoder().decode((await data.getContent(file!.contentHash!))!)).toBe('hello world');

    const conflict = await data.getConflict(file!.conflictId!);
    expect(conflict).toMatchObject({ vaultId, fileId, status: 'open', oursHash: file?.contentHash, theirsVV: { [deviceId]: 1, [otherDeviceId]: 1 } });
  });

  it('round-trips BlobStore uploads through MinIO with presigned PUT/GET and delete', async () => {
    await migrate(db);
    const blobStore = new BlobStore(s3Config(), data);
    const bytes = new TextEncoder().encode(`minio integration ${randomUUID()}`);
    const hash = await contentHash(bytes);

    const upload = await blobStore.initUpload(hash, bytes.byteLength);
    expect(upload.alreadyExists).toBe(false);
    expect(upload.url).toBeTruthy();

    const put = await fetch(upload.url!, { method: 'PUT', headers: { 'content-length': String(bytes.byteLength) }, body: bytes });
    expect(put.status).toBeGreaterThanOrEqual(200);
    expect(put.status).toBeLessThan(300);

    const verified = await blobStore.completeUpload(hash);
    expect(verified).toMatchObject({ hash, size: bytes.byteLength, state: 'verified' });
    expect(await data.getBlob(hash)).toMatchObject({ hash, state: 'verified', objectKey: verified.objectKey });

    const s3 = s3Client();
    const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: verified.objectKey }), { expiresIn: 60 });
    const downloaded = new Uint8Array(await (await fetch(getUrl)).arrayBuffer());
    expect(downloaded).toEqual(bytes);
    await expect(blobStore.verifyBytes(hash, downloaded)).resolves.toBeUndefined();

    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: verified.objectKey }));
    await expect(s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: verified.objectKey }))).rejects.toBeTruthy();
  });

  it('persists a full Layer-2 promote/update/demote flush into Layer 1 durably', async () => {
    await migrate(db);
    await seedIdentity(db);
    const processor = new OpProcessor(data);
    const yjsStore = new PgYjsRoomStore(db);
    const broadcasts: unknown[] = [];
    const manager = new RoomManager(data, yjsStore, processor, { closingGraceMs: 5, broadcastVault: (_vaultId, _source, ops) => broadcasts.push(...ops) });

    const create = await noteOp({ kind: 'create', text: 'hello', deviceSeq: 1, newPath: 'A.md', vv: { [deviceId]: 1 } });
    expect(await processor.process(create, userId)).toMatchObject({ type: 'ack' });

    const sink = new CapturingSink(deviceId);
    const state = await manager.promote(vaultId, fileId, deviceId, userId, sink);
    expect(textFromSnapshot(Buffer.from(state.yjsSnapshot, 'base64'))).toBe('hello');

    const update = yjsUpdateFrom(state.yjsSnapshot, (text) => text.insert(5, ' from yjs'));
    await manager.handleUpdate({ vaultId, fileId, deviceId, userId, roomEpoch: state.roomEpoch, updateId: 1, update });
    expect(sink.messages).toContainEqual({ t: 'yjs_ack', fileId, roomEpoch: state.roomEpoch, updateId: 1, seq: 1 });
    expect((await yjsStore.listUpdates(vaultId, fileId, state.roomEpoch)).map((stored) => stored.seq)).toEqual([1]);

    const finalHash = await manager.demote(vaultId, fileId, deviceId, state.roomEpoch);
    expect(finalHash).toBe(await contentHashText('hello from yjs'));

    const file = await data.getFile(vaultId, fileId);
    expect(file).toMatchObject({ contentHash: finalHash, contentVV: { [deviceId]: 1, [`collab:${fileId}`]: 1 }, activeUntil: null });
    expect(new TextDecoder().decode((await data.getContent(finalHash!))!)).toBe('hello from yjs');

    const ops = await data.listOps(vaultId, 0, 10);
    const collab = ops.at(-1)?.op;
    expect(collab).toMatchObject({ kind: 'update', deviceId: `collab:${fileId}`, deviceSeq: state.roomEpoch, inlineText: 'hello from yjs', contentHash: finalHash });
    expect(ops.map((entry) => entry.vaultSeq)).toEqual([1, 2]);
    expect(broadcasts).toHaveLength(1);

    const room = await yjsStore.getRoom(vaultId, fileId);
    expect(room).toMatchObject({ active: false, epoch: state.roomEpoch, compactedThroughSeq: 1 });
    expect(textFromSnapshot(room!.snapshot!)).toBe('hello from yjs');
  });
});

async function resetDatabase(db: PgDatabase): Promise<void> {
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
}

async function seedIdentity(db: PgDatabase): Promise<void> {
  await db.query('INSERT INTO vaults(vault_id,name,next_seq) VALUES($1,$2,1)', [vaultId, 'integration']);
  await db.query('INSERT INTO users(user_id,username,pw_hash) VALUES($1,$2,$3)', [userId, 'integration-user', 'not-used']);
  await db.query('INSERT INTO vault_members(vault_id,user_id,role) VALUES($1,$2,$3)', [vaultId, userId, 'editor']);
  await db.query('INSERT INTO devices(device_id,user_id,vault_id,name,last_device_seq,last_seq,revoked) VALUES($1,$2,$3,$4,0,0,false)', [deviceId, userId, vaultId, 'primary']);
  await db.query('INSERT INTO devices(device_id,user_id,vault_id,name,last_device_seq,last_seq,revoked) VALUES($1,$2,$3,$4,0,0,false)', [otherDeviceId, userId, vaultId, 'secondary']);
}

async function noteOp(input: { kind: 'create' | 'update'; text: string; deviceSeq: number; vv: Record<string, number>; deviceId?: string; newPath?: string }): Promise<FileOp> {
  const hash = await contentHashText(input.text);
  return {
    opId: randomUUID(),
    deviceId: input.deviceId ?? deviceId,
    deviceSeq: input.deviceSeq,
    fileId,
    vaultId,
    kind: input.kind,
    type: 'note',
    newPath: input.newPath,
    pathClock: input.newPath ? { lamport: 1, deviceId: input.deviceId ?? deviceId } : undefined,
    newContentVV: input.vv,
    contentHash: hash,
    inlineText: input.text,
    size: new TextEncoder().encode(input.text).byteLength,
    schemaVersion: 1,
  };
}

function yjsUpdateFrom(snapshot: string, mutate: (text: Y.Text) => void): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot, 'base64'));
  mutate(doc.getText('obsidian'));
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

function textFromSnapshot(snapshot: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  return doc.getText('obsidian').toString();
}

function s3Config() {
  return {
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
    region: process.env.S3_REGION ?? 'us-east-1',
  };
}

function s3Client(): S3Client {
  const config = s3Config();
  return new S3Client({ endpoint: config.endpoint, region: config.region, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, forcePathStyle: true });
}
