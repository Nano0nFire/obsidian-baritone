import { loadConfig } from './config.js';
import { PgDatabase } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PgAuthRepository } from './auth/pg-repository.js';
import { AuthService } from './auth/service.js';
import { TokenService } from './auth/tokens.js';
import type { Role } from './engine/store.js';

function args(): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 3; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    if (key?.startsWith('--')) out.set(key.slice(2), process.argv[++i] ?? '');
  }
  return out;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadConfig();
  const db = new PgDatabase(config.DATABASE_URL);
  try {
    const repo = new PgAuthRepository(db);
    const auth = new AuthService(repo, new TokenService(config.JWT_SECRET, repo));
    const a = args();
    if (command === 'migrate') console.log(JSON.stringify({ applied: await migrate(db) }));
    else if (command === 'create-user') console.log(JSON.stringify(await auth.createUser(required(a, 'username'), required(a, 'password'))));
    else if (command === 'create-vault') console.log(JSON.stringify(await auth.createVault(required(a, 'name'), required(a, 'owner-user-id'))));
    else if (command === 'add-member') { await auth.addMember(required(a, 'vault-id'), required(a, 'actor-user-id'), required(a, 'user-id'), required(a, 'role') as Role); console.log(JSON.stringify({ ok: true })); }
    else usage();
  } finally {
    await db.close();
  }
}

function required(a: Map<string, string>, key: string): string {
  const value = a.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function usage(): never {
  throw new Error('Usage: migrate | create-user --username --password | create-vault --name --owner-user-id | add-member --vault-id --actor-user-id --user-id --role');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
