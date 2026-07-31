// The host-wide network: one Velocity proxy (itzg/mc-proxy) that fronts the listed
// servers as sub-servers, so a player joins the proxy once and hops between them
// in-game. Everything here does a real thing to a real container — provision the
// proxy, write its config from the live backends, start/stop it. Deferred by
// design: on this shared host the proxy is held OFF until the operator turns it on,
// so it never competes with the live network for memory unasked.

import Docker from 'dockerode';
import { PassThrough, type Duplex } from 'node:stream';
import { mkdirSync, writeFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { NETWORK, NETWORK_ICONS, DEFAULT_ICONS, PLUGINS_DIST, PROXY_JAR, PROXY_MOTD, LOBBY_ADMIN, DATA_DIR, DEFAULT_RANKS, DEFAULT_RANK_ID, iconMaterial } from './config.js';
import { store, type Server, type Network } from './store.js';
import { containerName, dataDir, chownTree } from './docker.js';

const docker = new Docker(); // /var/run/docker.sock

export const PROXY_NAME = 'endhost-proxy';
const PROXY_DIR = join(DATA_DIR, 'proxy'); // bind-mounted at /server; holds velocity.toml + secret + the jar
const INTERNAL_PORT = 25577;               // what Velocity binds inside the container

function proxy() {
  return docker.getContainer(PROXY_NAME);
}

// A backend the proxy can route to: a server that exists, is running, and hasn't
// been hidden from the selector. The proxy reaches it on the container's own bridge
// IP at the internal Minecraft port (25565), never the published host port.
export interface Backend {
  server: Server;
  ip: string;
  key: string; // the name Velocity registers it under
}

async function containerIp(id: string): Promise<string | null> {
  try {
    const info = await docker.getContainer(containerName(id)).inspect();
    if (!info.State.Running) return null;
    const nets = info.NetworkSettings?.Networks || {};
    for (const n of Object.values(nets) as any[]) {
      if (n?.IPAddress) return n.IPAddress as string;
    }
    return (info.NetworkSettings as any)?.IPAddress || null;
  } catch {
    return null;
  }
}

// The Velocity server key for a server: `lobby` for the hub (so `/server lobby` and
// the selector are predictable), its subdomain if it has one (nice and human), else
// a safe slug of the id. Unique because the lobby is singular and subdomains unique.
// Exported so the lobby start-bridge can match a selector click back to a server.
export function keyFor(s: Server): string {
  if (s.role === 'lobby') return 'lobby';
  const base = (s.subdomain || s.id).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return base || `s_${s.id.slice(-6)}`;
}

// Every running, listed server that is a configured Velocity backend and has a
// reachable container IP right now. Only backends are routed — a stand-alone
// (online-mode) server would disconnect a proxied join, so it is never registered.
export async function liveBackends(): Promise<Backend[]> {
  const out: Backend[] = [];
  for (const s of store.listedServers()) {
    if (!s.backend) continue;
    const ip = await containerIp(s.id);
    if (ip) out.push({ server: s, ip, key: keyFor(s) });
  }
  return out;
}

// Escape a value for a TOML double-quoted string.
function toml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

// Modern Velocity renders the MOTD as MiniMessage and rejects legacy § colour
// codes outright, so translate the § codes a panel MOTD may carry into MiniMessage
// tags and escape any literal < so it isn't read as a tag.
const MINI: Record<string, string> = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua', '4': 'dark_red',
  '5': 'dark_purple', '6': 'gold', '7': 'gray', '8': 'dark_gray', '9': 'blue', a: 'green',
  b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white', l: 'bold', o: 'italic',
  n: 'underlined', m: 'strikethrough', k: 'obfuscated', r: 'reset',
};
function motdToMini(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === '§' || ch === '&') && i + 1 < s.length) {
      const code = s[++i].toLowerCase();
      if (MINI[code]) out += `<${MINI[code]}>`;
      continue; // drop unknown codes
    }
    if (ch === '<') { out += '\\<'; continue; }
    out += ch;
  }
  return out;
}

// Write velocity.toml + forwarding.secret into the proxy's config dir from the
// current backends. Modern forwarding (a shared secret) so backend servers trust
// the proxy's word for who a player is; the secret never leaves this host.
export function writeConfig(net: Network, backends: Backend[], opts: { onlineMode?: boolean } = {}): void {
  mkdirSync(PROXY_DIR, { recursive: true });
  const onlineMode = opts.onlineMode !== false;

  const servers = backends.map((b) => `${b.key} = "${b.ip}:${NETWORK.backendPort}"`);
  // Where a fresh join lands: the lobby if it is up, else any backend whose key
  // reads like a hub, else the first backend — so `try` always points somewhere
  // real. With none, Velocity still boots and simply has nowhere to send a player.
  const lobby = backends.find((b) => b.server.role === 'lobby') || backends.find((b) => /lobby|hub/.test(b.key)) || backends[0];
  const tryList = lobby ? `["${lobby.key}"]` : `[]`;

  const cfg = `# Generated by Endhost — do not edit by hand; the panel rewrites this.
config-version = "2.7"
bind = "0.0.0.0:${INTERNAL_PORT}"
motd = "${toml(motdToMini(net.motd))}"
show-max-players = 200
online-mode = ${onlineMode}
force-key-authentication = true
prevent-client-proxy-connections = false
player-info-forwarding-mode = "modern"
forwarding-secret-file = "forwarding.secret"
announce-forge = false
kick-existing-players = false
ping-passthrough = "DISABLED"
enable-player-address-logging = true

[servers]
${servers.join('\n')}
try = ${tryList}

[forced-hosts]

[advanced]
compression-threshold = 256
compression-level = -1
login-ratelimit = 3000
connection-timeout = 5000
read-timeout = 30000
tcp-fast-open = false
proxy-protocol = false
bungee-plugin-message-channel = true
show-ping-requests = false
failover-on-unexpected-server-disconnect = true
announce-proxy-commands = true
log-command-executions = false
log-player-connections = true

[query]
enabled = false
port = ${INTERNAL_PORT}
map = "Endhost"
show-plugins = false

[messages]
`;
  writeFileSync(join(PROXY_DIR, 'velocity.toml'), cfg);
  writeFileSync(join(PROXY_DIR, 'forwarding.secret'), net.secret);
}

export interface ProxyState {
  provisioned: boolean; // db has a network record
  exists: boolean;      // the container exists
  running: boolean;
  port: number;
  backends: number;
}

export async function state(): Promise<ProxyState> {
  const net = store.getNetwork();
  let exists = false, running = false;
  try {
    const info = await proxy().inspect();
    exists = true;
    running = info.State.Running;
  } catch (e: any) {
    if (e?.statusCode !== 404) throw e;
  }
  return {
    provisioned: !!net,
    exists,
    running,
    port: net?.port ?? NETWORK.port,
    backends: running ? (await liveBackends()).length : 0,
  };
}

// Provision the network for the first time: mint a forwarding secret and a record.
// Does not start anything — the proxy container is created lazily on the first start.
export function provision(): Network {
  const existing = store.getNetwork();
  if (existing) return existing;
  const net: Network = {
    secret: randomBytes(24).toString('hex'),
    port: NETWORK.port,
    motd: NETWORK.defaultMotd,
    running: false,
    createdAt: Date.now(),
    // Seed the maintenance whitelist with the operator so they can always get in.
    whitelist: [LOBBY_ADMIN.player],
    // Seed the rank ladder and make the operator the Owner.
    ranks: DEFAULT_RANKS.map((r) => ({ ...r, permissions: [...r.permissions] })),
    playerRanks: { [LOBBY_ADMIN.player.toLowerCase()]: 'owner' },
  };
  store.saveNetwork(net);
  return net;
}

async function ensureImage(): Promise<void> {
  const list = await docker.listImages({ filters: { reference: [NETWORK.image] } });
  if (list.length > 0) return;
  await new Promise<void>((resolve, reject) => {
    docker.pull(NETWORK.image, (err: any, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: any) => (e ? reject(e) : resolve()));
    });
  });
}

async function removeIfExists(): Promise<void> {
  try {
    await proxy().remove({ force: true, v: false }); // keep the config volume/bind
  } catch (e: any) {
    if (e?.statusCode !== 404) throw e;
  }
}

// The proxy's config.txt as EndhostProxy reads it: the normal/maintenance MOTDs, the kick
// line and the whitelist — a tiny key=value format with \n standing in for a line break.
function proxyConfigText(net: Network): string {
  const esc = (s: string) => s.replace(/\r?\n/g, '\\n');
  const whitelist = (net.whitelist ?? []).join(',');
  return [
    '# Written by Endhost — EndhostProxy reads this and reloads on change. Do not edit by hand.',
    `maintenance=${net.netMaintenance ? 'true' : 'false'}`,
    `motd.normal=${esc(net.motdNormal ?? PROXY_MOTD.normal)}`,
    `motd.maintenance=${esc(net.motdMaintenance ?? PROXY_MOTD.maintenance)}`,
    `kick=${esc(net.kickMessage ?? PROXY_MOTD.kick)}`,
    `whitelist=${whitelist}`,
    '',
  ].join('\n');
}

// Write EndhostProxy's config.txt into the proxy volume. The plugin watches the file, so a
// maintenance/MOTD/whitelist change is picked up without restarting the proxy.
export function writeProxyConfig(net: Network): void {
  const dir = join(PROXY_DIR, 'plugins', 'endhostproxy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.txt'), proxyConfigText(net));
  chownTree(dir);
}

// ---------------------------------------------------------------- rank system
// The ranks and the player→rank map, defaulted from the seed ladder for an older network record
// that predates the rank system. One model, written for both plugins: JSON the lobby reads and a
// derived flat text the proxy reads (the proxy API guarantees no JSON dependency).
function ranksOf(net: Network): { ranks: Network['ranks']; players: Record<string, string> } {
  return {
    ranks: net.ranks && net.ranks.length ? net.ranks : DEFAULT_RANKS,
    players: net.playerRanks ?? {},
  };
}

// ranks.json for the lobby's EndhostLobby plugin (watched, hot-reloaded). Lives beside
// network.json in the plugin's data folder. No-ops if the lobby volume isn't present yet.
export async function writeRanksJson(): Promise<void> {
  const lobby = store.lobbyServer();
  if (!lobby) return;
  const net = store.getNetwork();
  if (!net) return;
  const root = await dataDir(lobby.id).catch(() => null);
  if (!root) return;
  const { ranks, players } = ranksOf(net);
  const dir = join(root, 'plugins', 'EndhostLobby');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ranks.json'), JSON.stringify({ ranks, players, default: DEFAULT_RANK_ID, updatedAt: Date.now() }, null, 2));
  chownTree(dir);
}

// A UUID-shaped key (dashed or undashed hex) vs a plain Minecraft name.
function looksLikeUuid(key: string): boolean {
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(key) || /^[0-9a-f]{32}$/i.test(key);
}

// ranks.txt for the proxy's EndhostProxy plugin: each assigned player's rank expanded to its
// permission nodes, plus the default rank's nodes for everyone else. The proxy matches wildcards
// itself, so nodes are written verbatim.
function proxyRanksText(net: Network): string {
  const { ranks, players } = ranksOf(net);
  const byId = new Map((ranks ?? []).map((r) => [r.id, r]));
  const def = byId.get(DEFAULT_RANK_ID) ?? (ranks ?? [])[(ranks?.length ?? 1) - 1];
  const lines = [
    '# Written by Endhost — derived from the rank model. EndhostProxy reads this and reloads on change.',
    `default=${(def?.permissions ?? []).join(',')}`,
  ];
  for (const [rawKey, rankId] of Object.entries(players)) {
    const r = byId.get(rankId);
    if (!r) continue;
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const perms = r.permissions.join(',');
    if (looksLikeUuid(key)) lines.push(`uuid:${key.replace(/-/g, '')}=${perms}`);
    else lines.push(`name:${key}=${perms}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeProxyRanks(net: Network): void {
  const dir = join(PROXY_DIR, 'plugins', 'endhostproxy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ranks.txt'), proxyRanksText(net));
  chownTree(dir);
}

// Push the current rank model to both volumes — called after any rank edit.
export async function pushRanks(): Promise<void> {
  const net = store.getNetwork();
  if (!net) return;
  await writeRanksJson().catch(() => {});
  try { writeProxyRanks(net); } catch { /* proxy volume not present yet */ }
}

// Install the first-party proxy plugin from plugins-dist into the proxy volume. Any Via jars
// from the old layout (the stack now lives on the lobby) are cleared, our jar is refreshed,
// and its config.txt is (re)written from the current network record.
export async function installProxyPlugins(): Promise<void> {
  const dir = join(PROXY_DIR, 'plugins');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (/^(viaversion|viabackwards|viarewind|EndhostProxy)/i.test(f)) {
      try { rmSync(join(dir, f)); } catch { /* ignore */ }
    }
  }
  copyFileSync(join(PLUGINS_DIST, PROXY_JAR), join(dir, PROXY_JAR));
  const net = store.getNetwork();
  if (net) { writeProxyConfig(net); writeProxyRanks(net); }
  chownTree(dir);
  console.log('[endhost] proxy plugin installed: EndhostProxy.jar');
}

// Create the proxy container fresh from the current config and start it. Recreates
// if one already exists (config changes need a new container to take the new bind).
export async function up(opts: { onlineMode?: boolean } = {}): Promise<void> {
  const net = provision();
  const backends = await liveBackends();
  writeConfig(net, backends, opts);
  await ensureImage();
  await installProxyPlugins(); // the Via stack, freshly downloaded
  await removeIfExists();

  const c = await docker.createContainer({
    name: PROXY_NAME,
    Image: NETWORK.image,
    Tty: false,
    OpenStdin: true, // real console: attach stdin to type Velocity commands
    Labels: { 'endhost.managed': '1', 'endhost.role': 'proxy' },
    Env: [
      'TYPE=VELOCITY',
      `MEMORY=${NETWORK.heapMB}M`,
    ],
    ExposedPorts: { [`${INTERNAL_PORT}/tcp`]: {} },
    HostConfig: {
      Binds: [`${PROXY_DIR}:/server`],
      Memory: NETWORK.containerMB * 1024 * 1024,
      MemorySwap: NETWORK.containerMB * 1024 * 1024,
      NanoCpus: Math.round(NETWORK.cpus * 1e9),
      PortBindings: { [`${INTERNAL_PORT}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: String(net.port) }] },
      RestartPolicy: { Name: 'no' },
      PidsLimit: 512,
      SecurityOpt: ['no-new-privileges'],
    },
  });
  await c.start();
  store.patchNetwork({ running: true });
}

export async function down(): Promise<void> {
  try {
    await proxy().stop({ t: 20 });
  } catch (e: any) {
    if (e?.statusCode !== 404 && e?.statusCode !== 304) throw e;
  }
  store.patchNetwork({ running: false });
}

// Tear the proxy container down entirely (config on disk is kept, so a later `up`
// reuses the same secret). Used by the operator to reclaim the memory completely.
export async function destroy(): Promise<void> {
  await removeIfExists();
  store.patchNetwork({ running: false });
}

// Re-write the config from the current backends and, if the proxy is up, tell
// Velocity to reload it — no restart, no dropped players. Also regenerates the
// lobby's selector menu so it always mirrors the live server set. Called whenever
// the set of listed servers or their running state changes.
export async function refresh(): Promise<boolean> {
  const net = store.getNetwork();
  if (!net) return false;
  const backends = await liveBackends();
  writeConfig(net, backends);
  // Mirror the live network into the lobby's network.json; the plugin watches it and
  // re-renders the selector on its own, so no in-game reload command is needed.
  await writeNetworkJson(backends).catch(() => {});
  await writeRanksJson().catch(() => {});
  const st = await state();
  if (st.running) await send('velocity reload').catch(() => {});
  return st.running;
}

// -------------------------------------------------------------- in-game selector
// The lobby's EndhostLobby plugin renders the selector; the panel's only job is to publish
// the live server set into network.json in the plugin's data folder. Regenerated on every
// refresh so the menu is a true mirror of the network. The plugin watches the file's
// timestamp and re-renders on its own — no in-game reload command needed.

// The icon a server wears in the selector: its own if set, else a stable default derived
// from its id (mirrors index.ts's iconOf so the in-game tile matches the panel).
function iconFor(s: Server): string {
  if (s.icon && NETWORK_ICONS.includes(s.icon)) return s.icon;
  let h = 0;
  for (const ch of s.id) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  return DEFAULT_ICONS[h % DEFAULT_ICONS.length];
}

export async function writeNetworkJson(liveList?: Backend[]): Promise<void> {
  const lobby = store.lobbyServer();
  if (!lobby) return;
  const root = await dataDir(lobby.id).catch(() => null);
  if (!root) return;
  const live = liveList ?? (await liveBackends());
  const liveKeys = new Set(live.map((b) => b.key));

  // Every listed network backend — running or not — always shown, sorted by name. The
  // lobby itself is never in the list (players are already there; `/hub` brings them back).
  const servers = store.listedServers()
    .filter((s) => s.role !== 'lobby' && s.backend)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      key: keyFor(s),
      name: s.name,
      material: iconMaterial(iconFor(s)),
      online: liveKeys.has(keyFor(s)),
      startable: s.lobbyStartable === true,
    }));

  const dir = join(root, 'plugins', 'EndhostLobby');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'network.json'), JSON.stringify({ servers, updatedAt: Date.now() }, null, 2));
  chownTree(dir);
}

// Send one command to Velocity's real console over the container's stdin (the
// proxy is created with OpenStdin), the same pipe an operator typing at the
// terminal would use. Returns nothing to read back — Velocity's reply lands in the
// log stream (see follow), which is how a real console works.
export async function send(command: string): Promise<void> {
  const c = proxy();
  const stream = (await c.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true })) as Duplex;
  stream.write(command + '\n');
  await new Promise((r) => setTimeout(r, 120));
  stream.end();
}

// Follow the proxy's real console (docker logs). Same shape as docker.follow so the
// console WebSocket can stream it. Returns a stop() that detaches.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>NOc]/g;
export async function follow(onLine: (text: string) => void, tail = 250): Promise<() => void> {
  const raw = (await proxy().logs({ follow: true, stdout: true, stderr: true, tail, timestamps: false })) as unknown as Duplex;
  const sink = new PassThrough();
  docker.modem.demuxStream(raw, sink, sink);
  let buf = '';
  sink.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) onLine(line.replace(ANSI, ''));
  });
  return () => { raw.destroy?.(); sink.destroy?.(); };
}
