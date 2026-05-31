import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Build-time helper (plain ESM, outside tsc `include`); excluded from type-check but run by vitest.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- .mjs build helper has no type declarations
import { copyMigrations } from '../../scripts/copy-migrations.mjs';

describe('copyMigrations', () => {
  let root: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copy-mig-'));
    srcDir = join(root, 'src');
    destDir = join(root, 'dist');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, '001_initial.sql'), 'create table a();', 'utf8');
    await writeFile(join(srcDir, '002_more.sql'), 'create table b();', 'utf8');
    await writeFile(join(srcDir, 'migrate.ts'), '// not a migration', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies only .sql files into the destination, creating it if missing', async () => {
    const copied: string[] = await copyMigrations(srcDir, destDir);
    const present = (await readdir(destDir)).sort();
    expect(present).toEqual(['001_initial.sql', '002_more.sql']);
    expect(copied.map((p: string) => p.endsWith('.sql')).every(Boolean)).toBe(true);
    expect(copied).toHaveLength(2);
  });

  it('returns an empty list when the source has no .sql files', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });
    const copied: string[] = await copyMigrations(empty, join(root, 'out'));
    expect(copied).toEqual([]);
  });
});
