import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createLogger, parseLogLevel } from '../log/logger.js';
import { PgDatabase } from './pool.js';

export async function migrate(db: PgDatabase): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const existing = await db.query<{ version: string }>('SELECT version FROM schema_migrations WHERE version=$1', [version]);
    if (existing.rows.length > 0) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await db.withTx(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    }, 1);
    applied.push(version);
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const db = new PgDatabase(config.DATABASE_URL);
  migrate(db)
    .then((applied) => {
      process.stdout.write(`${JSON.stringify({ applied })}\n`);
    })
    .finally(() => db.close())
    .catch((error) => {
      createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) }).error('database migration failed', { event: 'database_migration_failed', error });
      process.exitCode = 1;
    });
}
