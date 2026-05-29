# Obsidian Sync

Self-hosted Obsidian vault sync with a two-layer architecture:

1. **Layer 1: file-level sync** — durable vault state is stored as PostgreSQL rows plus content-addressed blobs in S3/MinIO. The server never expands a vault to a working tree.
2. **Layer 2: live collaboration** — active notes can be promoted to Yjs rooms for real-time CRDT editing, then materialized back into Layer 1.

See [docs/detailed-design.md](docs/detailed-design.md) and [docs/spec-core-protocol.md](docs/spec-core-protocol.md) for protocol, auth, conflict, trash, and deployment details.

## Repository layout

```text
packages/shared   Protocol types, clocks, hashing, shared utilities
packages/server   Node.js API/WebSocket server, migrations, admin CLI
apps/plugin       Obsidian desktop/mobile plugin bundle
deploy/           Docker Compose, setup script, environment template
docs/             Architecture and protocol specifications
```

## Prerequisites

- Node.js 20+ and npm for development/builds
- Docker with Compose v2 for self-hosted deployment
- OpenSSL for `deploy/setup.sh` secret generation
- PostgreSQL 16 and S3-compatible storage, or the bundled Compose services

## Quick start (Docker)

```bash
cd deploy
./setup.sh
```

The script creates `deploy/.env`, optionally starts bundled PostgreSQL/MinIO/Caddy, runs migrations, and bootstraps an admin user with:

```bash
docker compose run --rm server obsidian-sync-server create-user --username admin --password '...'
```

For non-interactive provisioning, pass `SETUP_NONINTERACTIVE=1` and the variables shown in `deploy/.env.example`; set `SETUP_FORCE=1` to regenerate an existing `.env`.

## Manual deployment

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env
cd deploy
docker compose build server
docker compose run --rm migrate
docker compose up -d
```

Use `COMPOSE_PROFILES=bundled-db,bundled-minio` for local PostgreSQL and MinIO. Add `tls-caddy` plus `CADDY_DOMAIN`/`CADDY_EMAIL` for automatic HTTPS.

## Building the plugin

```bash
npm ci
npm run build --workspace @obsidian-sync/shared
npm run build --workspace obsidian-sync-plugin
```

The plugin build uses esbuild and emits Obsidian plugin artifacts such as `main.js` and `manifest.json` under `apps/plugin`. Install them into a vault at:

```text
<vault>/.obsidian/plugins/obsidian-sync/
```

Restart Obsidian or reload plugins, then configure the server `PUBLIC_URL` and user credentials.

## Development workflow

```bash
npm run build --workspace @obsidian-sync/shared
npm run build --workspace @obsidian-sync/server
npm run typecheck --workspace obsidian-sync-plugin
npm test --workspaces --if-present
npm run lint --if-present
```

Avoid committing generated `dist/`, plugin `main.js`, local `.env`, or deployment `data/` directories.

## Security notes

- Run behind TLS in production; use the `tls-caddy` profile or a trusted reverse proxy.
- `JWT_SECRET` must be unique, high entropy, and kept out of git.
- Plugin binary sync is code distribution. Only trust plugin updates from vault members you trust; shared-vault binary execution should remain gated by user approval.
- End-to-end encryption is deferred; the server can read synchronized content in the current design.

## License

MIT; see [LICENSE](LICENSE).
