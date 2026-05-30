# Obsidian Sync Plugin

Self-hosted Obsidian client for real-time vault sync, file-level reconciliation, Yjs-backed collaborative Markdown editing, and conflict resolution.

## Install with BRAT (beta)

1. Install and enable the Obsidian BRAT community plugin.
2. In BRAT settings, choose **Add Beta plugin**.
3. Enter this repository URL: `https://github.com/Nano0nFire/obsidian-baritone`.
4. Enable **Obsidian Sync** after BRAT installs or updates it.

Use BRAT only for beta testing against releases or branches you trust.

## Manual install

1. From this repository, build the plugin:
   ```bash
   cd apps/plugin
   npm run build
   ```
2. Copy the generated plugin bundle files from `apps/plugin/dist/` into your vault at:
   ```text
   <vault>/.obsidian/plugins/obsidian-sync/
   ```
   Required files are `main.js`, `manifest.json`, and `styles.css`.
3. Restart Obsidian or reload community plugins, then enable **Obsidian Sync**.

## Configuration overview

Open **Settings → Community plugins → Obsidian Sync**.

- **Server WebSocket URL**: sync endpoint, for example `wss://sync.example.com/sync`.
- **Vault ID**: server-side vault namespace. Defaults to `default`.
- **Device ID**: stable per-client identifier. Regenerate only when intentionally treating this client as a new device.
- **Login**: stores access and refresh tokens returned by the sync server.
- **Remote deletes**: chooses Obsidian `.trash` or system trash for files deleted by remote operations.
- **Pause sync**: stops local sync until resumed.

## COMMON vs DEVICE-LOCAL config sync

Each client independently chooses how to handle Obsidian configuration categories:

- **COMMON synced settings**: this category is included in shared sync and applied across clients.
- **DEVICE-LOCAL settings**: this category is excluded on this client and remains local.

Categories are:

- App settings: `.obsidian/app.json`, `appearance.json`, `hotkeys.json`
- Core plugins: `.obsidian/core-plugins.json`
- Community plugins: `.obsidian/community-plugins.json` and community plugin `manifest.json`, `main.js`, `styles.css`
- Plugin settings: community plugin `data.json` files
- Themes and snippets: `.obsidian/themes/` and `.obsidian/snippets/`
- Workspace layout: `.obsidian/workspace*.json` (defaults to device-local)

## `.ignore` rules

The plugin combines default exclusions with two editable gitignore-like rule layers:

- **Common `.ignore`**: synced project-wide exclusions.
- **Device-local `.ignore`**: exclusions that apply only on this client.

Supported rules include comments (`#`), `*`, `**`, `?`, directory rules ending in `/`, and negation rules beginning with `!`. Later matching rules win, so `!keep.secret` can re-include a file after `*.secret`.

Built-in exclusions include workspace layout files, `.trash/`, `.git/`, and `.DS_Store`.
