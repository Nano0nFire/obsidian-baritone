import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copy SQL migration files from `srcDir` into `destDir`.
 *
 * `tsc` only emits `.js`/`.d.ts` and silently drops non-TS assets, so the raw
 * `.sql` migrations never reach `dist/db/migrations` without this step. The
 * server reads migrations from the compiled location at runtime, so this must
 * run as part of the build (see the server package `build` script).
 *
 * @param {string} srcDir  directory containing `*.sql` files
 * @param {string} destDir directory to copy them into (created if missing)
 * @returns {Promise<string[]>} absolute paths of the copied files
 */
export async function copyMigrations(srcDir, destDir) {
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const sqlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
  if (sqlFiles.length === 0) return [];
  await mkdir(destDir, { recursive: true });
  const copied = [];
  for (const name of sqlFiles) {
    const dest = join(destDir, name);
    await cp(join(srcDir, name), dest);
    copied.push(dest);
  }
  return copied;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(here, '..', 'src', 'db', 'migrations');
  const destDir = join(here, '..', 'dist', 'db', 'migrations');
  copyMigrations(srcDir, destDir)
    .then((copied) => {
      process.stdout.write(`${JSON.stringify({ copiedMigrations: copied.length })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`copy-migrations failed: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
