// The lobby's content install: what turns a bare Velocity backend into the real hub. The
// hub world is already in the volume and is left untouched — this only drops in the
// first-party EndhostLobby plugin, writes its config, and clears out the old third-party
// plugin stack (TAB, DeluxeMenus, ItemJoin, LuckPerms, PlaceholderAPI, FastAsyncWorldEdit)
// it replaces. World-safe and idempotent: it never reads or writes the world/ folder, so it
// can run against a live lobby volume without losing the map. The Via stack is installed
// separately by the caller (index.ts) via the Modrinth path.

import { mkdirSync, writeFileSync, copyFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOBBY_ADMIN, LOBBY_JAR, PLUGINS_DIST, JOIN_HOST } from './config.js';
import { chownTree } from './docker.js';

// The plugins the EndhostLobby jar replaces; their folders and jars are removed on install.
const LEGACY_DIRS = ['TAB', 'DeluxeMenus', 'ItemJoin', 'LuckPerms', 'PlaceholderAPI', 'FastAsyncWorldEdit'];
const LEGACY_JAR = /^(TAB|DeluxeMenus|ItemJoin|LuckPerms|PlaceholderAPI|FastAsyncWorldEdit)/i;

// config.yml as the plugin reads it: who is an admin, the address shown on the board, and
// the admin prefix. Spawn is deliberately absent — the plugin owns spawn.yml (/setspawn).
function lobbyConfigYaml(): string {
  const admins = [LOBBY_ADMIN.player].map((a) => `  - ${a}`).join('\n');
  const prefix = LOBBY_ADMIN.prefix.replace(/'/g, "''");
  return (
    `# Written by Endhost on install. Admins (names or UUIDs), the join address shown on the\n` +
    `# board, and the admin prefix. Spawn is set in-game with /setspawn and lives in spawn.yml.\n` +
    `admins:\n${admins}\n` +
    `address: ${JOIN_HOST}\n` +
    `prefix-admin: '${prefix}'\n`
  );
}

// Remove the third-party plugin stack the first-party plugin replaces, plus Paper's remap
// cache so nothing stale is re-remapped on the next boot. Never touches the world.
function removeLegacyPlugins(pluginsDir: string): void {
  for (const d of LEGACY_DIRS) rmSync(join(pluginsDir, d), { recursive: true, force: true });
  for (const f of readdirSync(pluginsDir)) {
    if (f.endsWith('.jar') && LEGACY_JAR.test(f)) rmSync(join(pluginsDir, f), { force: true });
  }
  rmSync(join(pluginsDir, '.paper-remapped'), { recursive: true, force: true });
}

// Install the first-party lobby plugin into an existing (or fresh) lobby volume: clear the
// legacy plugins, copy in EndhostLobby.jar, seed its config.yml (once) and the start-bridge
// folders. The world and any /setspawn are left alone. Hand the tree to uid 1000 so the
// container can read and write it.
export function installLobbyContent(root: string): void {
  const pluginsDir = join(root, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  removeLegacyPlugins(pluginsDir);

  copyFileSync(join(PLUGINS_DIST, LOBBY_JAR), join(pluginsDir, LOBBY_JAR));

  const dataDir = join(pluginsDir, 'EndhostLobby');
  mkdirSync(join(dataDir, 'requests'), { recursive: true });
  mkdirSync(join(dataDir, 'responses'), { recursive: true });
  // Write config.yml only if it's missing, so an operator's edited admin list (applied with
  // /lobbyreload) survives a redeploy. The bridge folders and jar are always refreshed.
  const cfg = join(dataDir, 'config.yml');
  if (!existsSync(cfg)) writeFileSync(cfg, lobbyConfigYaml());

  chownTree(pluginsDir);
}
