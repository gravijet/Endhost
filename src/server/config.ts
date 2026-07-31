// Endhost — server configuration.
//
// Every limit here exists to keep this panel from ever threatening the machine
// it shares with a live network. Nothing is advertised that the host cannot
// actually deliver: the free plan is the only one the panel provisions, and it
// provisions it for real.

import { join } from 'node:path';
import type { Rank } from './store.js';

// The bundle runs as dist/server/index.cjs, so __dirname (provided by the CJS
// output) is dist/server and the project root is two levels up.
export const ROOT = process.env.ENDHOST_ROOT || join(__dirname, '..', '..');
export const DATA_DIR = process.env.ENDHOST_DATA || join(ROOT, 'data');
export const PUBLIC_DIR = join(ROOT, 'public');

export const PORT = Number(process.env.PORT || 8791);
export const HOST = process.env.HOST || '127.0.0.1';

// Cookies are Secure by default; the site is HTTPS end to end (Cloudflare Full).
// Turn it off only for plain-HTTP local testing.
export const SECURE_COOKIES = process.env.ENDHOST_INSECURE_COOKIES !== '1';

// The address a player types to join. example.invalid is proxied by Cloudflare, which
// does not carry arbitrary Minecraft TCP, so joins use a direct (grey-cloud) host.
export const JOIN_HOST = process.env.ENDHOST_JOIN_HOST || 'example.invalid';

// The host's public IP. This is where a custom domain's A record must point (and
// the wildcard *.example.invalid too) — Cloudflare can't proxy Minecraft TCP, so the
// record has to be grey-cloud straight to the origin. Shown in the panel and used
// to verify a domain actually resolves here.
export const PUBLIC_IP = process.env.ENDHOST_PUBLIC_IP || '192.0.2.1';

export const IMAGE = 'itzg/minecraft-server:latest';

// The one plan the panel actually builds. containerMB is the hard cgroup cap;
// heapMB is the JVM's -Xmx. The gap (~640 MB) is the JVM's non-heap footprint —
// measured, not guessed: an 896 MB heap sat at 1.22 GB RSS, so a 1 GB heap needs
// ~1.6 GB before the kernel OOM-kills it.
export const FREE_PLAN = {
  id: 'endstone',
  name: 'End Stone',
  ramMB: 1024, // what the player's server (JVM heap) actually gets
  heapMB: 1024,
  containerMB: 1664,
  cpus: 1.5,
  maxPlayers: 20,
};

// Global rails. Concurrency is the one that protects live memory; the rest bound
// how much can be created at all.
//
// defaultServersPerUser is the limit a brand-new account gets. An admin can raise
// any single account's limit (user.serverLimit) — for a builder who wants a lobby
// plus a survival world, say — but the two host-level rails still hold: at most
// maxConcurrentRunning run at once (the ~1.6 GB-each memory ceiling) and at most
// maxTotalServers exist on the whole host (a disk ceiling), whatever the per-user
// limits add up to.
export const LIMITS = {
  maxConcurrentRunning: 2, // most a running server costs is ~1.6 GB; two is ~3.3 GB
  maxTotalServers: 8,
  defaultServersPerUser: 1,
  maxServerLimit: 25, // the highest an admin may set a single account to
  portRange: { from: 25800, to: 25899 },
};

// A free server that has been empty this long is put to sleep (stopped), which
// hands its memory straight back. This is the "sleeps when empty" line, made real.
export const IDLE_SLEEP_MS = 15 * 60 * 1000;
export const REAPER_INTERVAL_MS = 2 * 60 * 1000;

// The web file manager. maxEditBytes is the largest file the in-browser editor
// will open (bigger ones are download-only); maxUploadBytes bounds a single
// upload — enough for plugin/mod jars and modest world zips, not a disk-filler.
export const FILES = {
  maxEditBytes: 2 * 1024 * 1024,
  maxUploadBytes: 250 * 1024 * 1024,
};

// World backups. A snapshot is a gzipped tar of the server's whole /data volume,
// kept on the host outside the volume itself. The caps here are what protects the
// shared disk: only a few per server, none taken when the disk is low, and never a
// world so large it could fill the machine. dir defaults under DATA_DIR (root-owned,
// same as db.json), so the service — which runs as root for the docker socket — can
// write it without extra plumbing.
export const BACKUPS = {
  dir: process.env.ENDHOST_BACKUP_DIR || join(DATA_DIR, 'backups'),
  maxPerServer: Number(process.env.ENDHOST_BACKUP_MAX || 3),
  minFreeBytes: 3 * 1024 * 1024 * 1024,  // refuse a new backup if the disk has less free than this
  maxVolumeBytes: 4 * 1024 * 1024 * 1024, // refuse to snapshot a world larger than this
};

// Per-server SFTP. One gateway process authenticates every account against its
// own SFTP password and jails each session to that server's /data volume — the
// same real files the web manager shows. The username a client types is the
// server's id; the password is the account's SFTP password (set in the panel).
//
// Port note: 2022 on this host already belongs to the live network's own panel,
// so Endhost uses 2222. Cloudflare cannot proxy SSH/SFTP, so publicHost is a
// direct (grey-cloud) host — the origin IP until an example.invalid record is
// pointed straight at it.
export const SFTP = {
  enabled: process.env.ENDHOST_SFTP_DISABLE !== '1',
  bindHost: process.env.ENDHOST_SFTP_BIND || '0.0.0.0',
  port: Number(process.env.ENDHOST_SFTP_PORT || 2222),
  publicHost: process.env.ENDHOST_SFTP_HOST || '192.0.2.1',
  hostKeyPath: process.env.ENDHOST_SFTP_HOSTKEY || join(DATA_DIR, 'sftp_host_key'),
  minPasswordLength: 8,
};

// Guthaben (credits). A real balance ledger: an admin tops an account up (the
// only funding path until a payment provider is wired), and credits buy the one
// perk that is genuinely safe on this shared host — keeping a server awake past
// the idle window. RAM stays fixed at the free plan's 1 GB, so nothing here can
// grow the host's memory footprint; credits only trade against the idle-sleep
// that would otherwise hand that memory back.
//
// alwaysOnPerHour is billed by real elapsed time (prorated each reaper tick), so
// a balance of 120 credits buys ~24h at the default rate. ENDHOST_CREDIT_RATE can
// override it (a small value makes deduction observable in a test).
export const CREDITS = {
  alwaysOnPerHour: Number(process.env.ENDHOST_CREDIT_RATE || 5),
  startingBalance: Number(process.env.ENDHOST_START_CREDITS || 0),
};

// The account that may grant credits and see every user. Marked admin at boot.
export const ADMIN_EMAIL = (process.env.ENDHOST_ADMIN_EMAIL || 'user@example.invalid').toLowerCase();

// Per-server subdomains. One TCP listener reads the hostname a player typed (it
// lives in the Minecraft handshake packet) and forwards the connection to that
// server's container on the loopback — so only ONE port faces the internet and
// the per-container ports never leave localhost. Cloudflare can't proxy Minecraft
// TCP, so the wildcard `*.example.invalid` must be a grey-cloud A record straight to
// the origin IP (the operator sets this once).
//
// Port note: 25565 on this host belongs to the live network, so the router uses
// 25580. Players reach a subdomain either as `example.invalid:25580` or, with a
// per-subdomain/wildcard SRV record, as a bare `example.invalid` (the client then
// finds the port itself). `srvPort` is what a status/SRV answer advertises.
export const MCROUTER = {
  enabled: process.env.ENDHOST_ROUTER_DISABLE !== '1',
  port: Number(process.env.ENDHOST_ROUTER_PORT || 25580),
  bindHost: process.env.ENDHOST_ROUTER_BIND || '0.0.0.0',
  domain: (process.env.ENDHOST_DOMAIN || 'example.invalid').toLowerCase(),
  // When a wildcard SRV record hides the port, advertise the bare hostname;
  // otherwise show `host:port`, which is always correct.
  srv: process.env.ENDHOST_ROUTER_SRV === '1',
};

// The host-wide network. One Velocity proxy (itzg/mc-proxy) fronts the listed
// servers as sub-servers, so a player joins the proxy once and hops between them
// in-game via the selector. It is DEFERRED by design: on this shared host a proxy
// held in RAM 24/7 would compete with the live network next door, so the panel
// provisions it, proves it, and leaves it OFF until the operator turns it on.
//
// Port note: the proxy is the front door of the whole network, so it takes the
// default Minecraft port 25565 — players join `example.invalid` with no port at all.
// (25580 stays the subdomain router for direct per-server joins.) image is the itzg
// proxy image; heapMB keeps Velocity small (it holds no world). backendPort is the
// port every managed backend exposes inside its container — always 25565 — reached
// on the container's own IP from the proxy.
export const NETWORK = {
  image: process.env.ENDHOST_PROXY_IMAGE || 'itzg/mc-proxy:latest',
  port: Number(process.env.ENDHOST_PROXY_PORT || 25565),
  heapMB: Number(process.env.ENDHOST_PROXY_HEAP || 512),
  containerMB: Number(process.env.ENDHOST_PROXY_CONTAINER || 768),
  cpus: Number(process.env.ENDHOST_PROXY_CPUS || 1),
  backendPort: 25565,
  defaultMotd: 'Endhost Network — pick a server',
};

// The Minecraft-item icons a server can wear in the network selector. Each id has a
// matching sprite at public/assets/img/items/<id>.png (generated by
// scripts/gen-items.py — our own pixel art, not Mojang's files). The panel offers
// exactly this set, and icon changes are validated against it.
export const NETWORK_ICONS = [
  'grass_block', 'stone', 'cobblestone', 'dirt', 'oak_planks', 'diamond_block',
  'gold_block', 'iron_block', 'emerald_block', 'netherite_block', 'redstone_block',
  'lapis_block', 'obsidian', 'end_stone', 'purpur_block', 'bricks', 'glowstone',
  'diamond_ore', 'netherrack', 'tnt', 'crafting_table', 'furnace', 'bookshelf',
  'diamond', 'emerald', 'gold_ingot', 'iron_ingot', 'netherite_ingot', 'nether_star',
  'ender_eye', 'diamond_sword', 'compass', 'apple', 'golden_apple',
];
export const DEFAULT_ICONS = ['grass_block', 'diamond_block', 'emerald_block', 'gold_block', 'end_stone', 'purpur_block', 'nether_star', 'ender_eye', 'diamond_ore', 'glowstone'];

// The plugin/mod marketplace is Modrinth (labrinth API v2) — no key needed, just
// a courteous User-Agent. We only ever fetch its search/version JSON and download
// the primary jar it names, into the server's own plugins/ or mods/ folder, after
// verifying the sha512 Modrinth published for that file. Nothing else is trusted.
export const MODRINTH = {
  api: 'https://api.modrinth.com/v2',
  userAgent: 'Endhost/1.0 (+https://example.invalid)',
  maxFileBytes: 200 * 1024 * 1024,
  searchLimit: 20,
};

// The Minecraft versions the panel offers, newest first. Minecraft/Paper moved to
// calendar versioning in 2026 (26.1, 26.2), so the modern releases lead; the 1.21
// and older lines stay for people who want them. Whatever version a server runs, any
// client version can still join because the proxy runs the Via stack (see network.ts),
// so this list is about the server build, not who can connect.
export const ALLOWED_VERSIONS = ['26.2', '26.1.2', '1.21.11', '1.21.8', '1.21.4', '1.21.1', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5', '1.12.2', '1.8.8'];
export const DEFAULT_VERSION = '26.1.2';

// The server flavours the panel can actually build reliably. Each maps to an
// itzg TYPE and declares the lowest Minecraft version it supports, so the panel
// never offers a software+version pair that would fail to boot. Spigot is left
// out on purpose: it compiles from source with BuildTools and can take many
// minutes, which would break the "online in about a minute" promise.
export interface Software {
  id: string;
  label: string;
  type: string; // the itzg TYPE env value
  kind: 'plugins' | 'mods' | 'vanilla';
  minVersion: string;
  note: string;
}
export const SOFTWARE: Software[] = [
  { id: 'paper',   label: 'Paper',   type: 'PAPER',   kind: 'plugins', minVersion: '1.8',  note: 'Fast and plugin-ready. The usual choice.' },
  { id: 'purpur',  label: 'Purpur',  type: 'PURPUR',  kind: 'plugins', minVersion: '1.14', note: 'A Paper fork with more knobs. Plugins work.' },
  { id: 'fabric',  label: 'Fabric',  type: 'FABRIC',  kind: 'mods',    minVersion: '1.14', note: 'Lightweight modding. Loads Fabric mods.' },
  { id: 'forge',   label: 'Forge',   type: 'FORGE',   kind: 'mods',    minVersion: '1.8',  note: 'The classic mod loader. Loads Forge mods.' },
  { id: 'vanilla', label: 'Vanilla', type: 'VANILLA', kind: 'vanilla', minVersion: '1.8',  note: 'The game as Mojang ships it — no plugins or mods.' },
];
export const DEFAULT_SOFTWARE = 'paper';

export function softwareById(idv: string): Software | undefined {
  return SOFTWARE.find((s) => s.id === idv);
}

// The network's lobby — the hub players land on by default. A managed server like
// any other, but system-owned (the admin account). Its world is already installed and is
// left as-is; the hub's tablist, scoreboard, join items, selector, admin rank, spawn and
// admin tools all come from the first-party EndhostLobby plugin. Always a Velocity backend.
// There is exactly one. (The `world` block below is historical — the map is already in the
// volume and is no longer re-pasted; the plugin's /setspawn owns the spawn now.)
export const LOBBY = {
  name: 'Lobby',
  software: 'paper',
  // Pinned to the newest version the selector plugin (DeluxeMenus) supports — it
  // trails the game's calendar releases, and the proxy's Via stack lets any client
  // version reach the lobby regardless.
  version: '1.21.11',
  heapMB: 896,
  containerMB: 1408,
  icon: 'end_stone',
  motd: 'Endhost Lobby',
  subdomain: 'lobby',
  // The downloaded hub world. A Sponge schematic (Springtime Spawn by Katorly,
  // CC-BY-NC-ND 4.0 — credited in the tablist footer) fetched from GitHub and pasted
  // into a fresh void world on first boot with FastAsyncWorldEdit. Non-commercial
  // licence: fine for this free hub, swap it if hosting is ever monetised.
  world: {
    schematicUrl: 'https://github.com/katorlys/SpringtimeSpawn/raw/main/SpringtimeSpawn.schem',
    name: 'spawn',                          // saved as plugins/FastAsyncWorldEdit/schematics/spawn.schem
    credit: 'Springtime Spawn by Katorly',
    anchor: { x: -39, y: 64, z: -39 },      // min corner; footprint 79x79x17 centres on (0,*,0)
    size: { w: 79, h: 17, l: 79 },
    // A flat, dry, walkable spot on the build (verified live): near-centre ground,
    // one above the floor. fallDamage is disabled on the lobby as a safety net.
    spawn: { x: -6, y: 68, z: 0 },
  },
};

// The itzg env the lobby boots with on top of the usual backend env: a void
// superflat (so only the pasted build exists), plus hub quality-of-life — adventure
// mode (join items can't be dropped or used to break blocks), peaceful, no mobs, no
// structures, flight allowed for elevated builds.
export const LOBBY_ENV = [
  'LEVEL_TYPE=minecraft:flat',
  'GENERATOR_SETTINGS={"layers":[{"block":"minecraft:air","height":1}],"biome":"minecraft:the_void"}',
  'MODE=adventure',           // itzg's env for gamemode (not GAMEMODE) — keeps the hub unbreakable
  'FORCE_GAMEMODE=true',
  'DIFFICULTY=peaceful',
  'ALLOW_NETHER=false',
  'SPAWN_ANIMALS=false',
  'SPAWN_MONSTERS=false',
  'SPAWN_NPCS=false',
  'GENERATE_STRUCTURES=false',
  'VIEW_DISTANCE=8',
  'SIMULATION_DISTANCE=5',
  'ALLOW_FLIGHT=true',
  'ENABLE_COMMAND_BLOCK=false',
];

// Modrinth plugins installed on the lobby: only the Via stack now. Cross-version support
// lives on the lobby backend by deliberate choice (see PROXY_PLUGINS / network.ts). Every
// piece of the lobby's own behaviour — tablist, scoreboard, selector, the one admin rank,
// spawn and the admin tools — is the first-party EndhostLobby plugin (LOBBY_JAR), copied
// from plugins-dist rather than fetched from Modrinth. ViaVersion lets newer clients join,
// ViaBackwards older ones, ViaRewind the oldest (1.8/1.7).
export const LOBBY_PLUGINS = ['viaversion', 'viabackwards', 'viarewind'];

// The built first-party plugin jars (plugins-src/, built by scripts/build-plugins.mjs).
// The panel copies these into the lobby and proxy volumes on install; they are tracked in
// plugins-dist/ so a deploy never has to run Maven.
export const PLUGINS_DIST = join(ROOT, 'plugins-dist');
export const LOBBY_JAR = 'EndhostLobby.jar';
export const PROXY_JAR = 'EndhostProxy.jar';

// The network proxy's server-list identity, as EndhostProxy reads it from its config.txt:
// two MOTDs (normal + maintenance) with a toggle, a kick line shown to players turned away
// during maintenance, and a whitelist that only applies while maintenance is on (seeded with
// the operator so they can always get in). All editable from the admin Network page. This
// "network maintenance" is distinct from the host-wide maintenance switch that vacates ports.
export const PROXY_MOTD = {
  normal: '&b&lGRAVIJET NETWORK\n&7Choose a server and play.',
  maintenance: '&6&lGRAVIJET NETWORK\n&e&lMaintenance &7— back soon.',
  kick: '&e&lMaintenance\n&7The network is briefly offline. Please check back soon.',
};

// The operator account seeded as the network Owner in the rank system, and the fallback admin
// written into the lobby's config.yml so they can never be locked out before ranks.json exists.
export const LOBBY_ADMIN = {
  player: process.env.ENDHOST_LOBBY_ADMIN || 'gravijet',
  prefix: '&c[Admin] &r',
};

// The default rank ladder, seeded on first provision and editable from the admin Ranks page.
// Ranks carry a chat/tab prefix, a name colour, a sort weight (higher = nearer the top of the
// tab list) and permission nodes; both plugins read them from the panel-written rank files, so
// one definition drives prefixes and permissions on the lobby and the proxy alike. `default` is
// the fallback rank and must always exist. `endhost.staff` lets a rank bypass proxy maintenance;
// `endhost.build` is the lobby build/manage bypass; `endhost.command.<name>` gates each command.
export const DEFAULT_RANK_ID = 'default';
export const DEFAULT_RANKS: Rank[] = [
  { id: 'owner',  name: 'Owner',  prefix: '&4&l[Owner] &r', color: '&4', weight: 100, permissions: ['*'] },
  { id: 'admin',  name: 'Admin',  prefix: '&c[Admin] &r',   color: '&c', weight: 90,  permissions: ['endhost.*'] },
  { id: 'mod',    name: 'Mod',    prefix: '&9[Mod] &r',     color: '&9', weight: 70,  permissions: ['endhost.staff', 'endhost.build', 'endhost.command.tp', 'endhost.command.tphere', 'endhost.command.fly', 'endhost.command.broadcast', 'endhost.command.vanish', 'endhost.command.gm'] },
  { id: 'helper', name: 'Helper', prefix: '&b[Helper] &r',  color: '&b', weight: 50,  permissions: ['endhost.staff', 'endhost.command.tp', 'endhost.command.broadcast'] },
  { id: 'vip',    name: 'VIP',    prefix: '&6[VIP] &r',     color: '&6', weight: 20,  permissions: [] },
  { id: 'default', name: 'Member', prefix: '',              color: '&7', weight: 0,   permissions: [] },
];

// The permission nodes the dashboard offers as suggestions when editing a rank. Not a hard
// limit — an admin can type any node — just the ones the plugins actually check.
export const PERMISSION_NODES = [
  '*', 'endhost.*', 'endhost.staff', 'endhost.build', 'endhost.admin', 'endhost.proxy.admin',
  'endhost.command.*', 'endhost.command.setspawn', 'endhost.command.gm', 'endhost.command.fly',
  'endhost.command.speed', 'endhost.command.tp', 'endhost.command.tphere', 'endhost.command.broadcast',
  'endhost.command.heal', 'endhost.command.feed', 'endhost.command.day', 'endhost.command.night',
  'endhost.command.vanish', 'endhost.command.clearchat', 'endhost.command.lobbyreload',
];

// The in-game server selector is rendered by the EndhostLobby plugin from the network.json
// the panel writes into the lobby volume (see network.writeNetworkJson) — always six rows,
// every server shown (online or not), paged with previous/next arrows. Velocity's built-in
// `/server <name>` remains the always-works fallback.

// The network proxy runs only the first-party EndhostProxy plugin (PROXY_JAR), copied from
// plugins-dist. Nothing is fetched from Modrinth for it: the Via stack was moved onto the
// lobby backend at the operator's request, so it is installed there (LOBBY_PLUGINS), not here.
export const PROXY_PLUGINS: string[] = [];

// A network-selector item id → the Bukkit Material the selector GUI shows for it.
// Our icon ids are the vanilla item ids, so the material is just the upper-case form
// (grass_block → GRASS_BLOCK); a couple of ids differ from their material and are
// mapped explicitly.
export function iconMaterial(icon: string): string {
  const special: Record<string, string> = { golden_apple: 'GOLDEN_APPLE' };
  return special[icon] || icon.toUpperCase();
}

// Compare dotted Minecraft versions numerically: 1.21.4 >= 1.14, 1.8.8 >= 1.8.
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

// The subset of ALLOWED_VERSIONS a given software can actually run.
export function versionsFor(softwareId: string): string[] {
  const sw = softwareById(softwareId);
  if (!sw) return [];
  return ALLOWED_VERSIONS.filter((v) => versionAtLeast(v, sw.minVersion));
}
