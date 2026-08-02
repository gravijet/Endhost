// The layer that actually reaches the game. Every function here does a real
// thing to a real container; if the daemon or the container says no, the error
// propagates rather than being smoothed into a fake success.

import Docker from 'dockerode';
import { PassThrough, type Duplex } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chownSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE, FREE_PLAN, softwareById } from './config.js';
import type { Server } from './store.js';

const docker = new Docker(); // /var/run/docker.sock

export const containerName = (id: string) => `endhost-${id}`;

// The itzg image runs the server as uid/gid 1000; files we drop into the /data
// volume from the host (as root) must be handed to that user or the server (which
// runs as 1000 and cannot chown) fails to write into them — a fresh root-owned
// plugins/ dir, for instance, stops Paper creating its remap cache on boot.
const MC_UID = 1000, MC_GID = 1000;

// Recursively hand a path (and everything under it) to the container user. Best
// effort: a file that vanishes mid-walk is skipped rather than fatal.
export function chownTree(path: string, uid = MC_UID, gid = MC_GID): void {
  try {
    chownSync(path, uid, gid);
    if (statSync(path).isDirectory()) for (const e of readdirSync(path)) chownTree(join(path, e), uid, gid);
  } catch { /* best effort */ }
}

// How a server joins the host-wide Velocity network. When present the container is
// built as a proxy backend: online-mode off (the proxy authenticated the player and
// forwards a signed profile) and the modern-forwarding secret written into Paper's
// config, so a join arriving via the proxy is trusted instead of rejected.
export interface BackendOpts {
  velocitySecret?: string; // set → configure as a Velocity backend
  heapMB?: number;         // override the JVM heap (the lobby runs lean)
  containerMB?: number;    // override the cgroup memory cap
  extraEnv?: string[];     // extra itzg env (KEY=VALUE) — the lobby's void world + hub settings
}

export interface LiveState {
  exists: boolean;
  running: boolean;
  health: string | null;
  startedAt: string | null;
  oomKilled: boolean;
  exitCode: number | null; // last exit code while stopped (0 = clean); null while running
}

// Stops the panel itself initiates — a manual stop, the idle reaper, host
// maintenance, a restart or an in-place rebuild — are *expected*. We remember them
// here briefly so the alerts monitor can tell a graceful shutdown from a crash
// without threading "did we mean to do this?" through every call site: every
// intentional down-transition runs through the functions below.
const expectedStops = new Map<string, number>();
export function markExpectedStop(id: string): void { expectedStops.set(id, Date.now()); }
export function wasExpectedStop(id: string): boolean {
  const t = expectedStops.get(id);
  if (t === undefined) return false;
  if (Date.now() - t > 5 * 60_000) { expectedStops.delete(id); return false; } // stale — treat as unexpected
  return true;
}
export function clearExpectedStop(id: string): void { expectedStops.delete(id); }

function get(id: string) {
  return docker.getContainer(containerName(id));
}

// Build the create spec for a server. `volumeName` reuses an existing /data volume
// (so a rebuild keeps the world); omitted, the itzg image mounts a fresh anonymous
// one. `opts` decides online-mode / heap and whether it is a proxy backend.
function createSpec(s: Server, volumeName: string | undefined, opts: BackendOpts): Docker.ContainerCreateOptions {
  const sw = softwareById(s.software) ?? softwareById('paper')!;
  const backend = !!opts.velocitySecret;
  const heap = opts.heapMB ?? FREE_PLAN.heapMB;
  const cap = opts.containerMB ?? FREE_PLAN.containerMB;
  return {
    name: containerName(s.id),
    Image: IMAGE,
    // No TTY: a TTY makes the console runner draw an interactive prompt (cursor
    // moves, bracketed-paste toggles) that would leak into the log stream. Off,
    // the logs are the server's own lines and nothing else — we demux them below.
    Tty: false,
    // Keep stdin open so the panel can type into the server's *real* console: we
    // attach and write the line, exactly what an operator at the terminal does, and
    // mc-server-runner forwards it to the Minecraft process. The command's output
    // comes back through the ordinary log stream (see follow) — which is what a real
    // console looks like. This is why console commands no longer need RCON.
    OpenStdin: true,
    StdinOnce: false,
    Labels: { 'endhost.managed': '1', 'endhost.id': s.id, 'endhost.owner': s.owner },
    Env: [
      'EULA=TRUE',
      `TYPE=${sw.type}`,
      `VERSION=${s.version}`,
      `MEMORY=${heap}M`,
      // Behind the proxy the player is already authenticated — the backend must run
      // offline or it would try (and fail) to re-authenticate the forwarded profile.
      `ONLINE_MODE=${backend ? 'FALSE' : 'TRUE'}`,
      'ENABLE_RCON=TRUE',
      `RCON_PASSWORD=${s.rconPassword}`,
      `MOTD=${s.motd}`,
      'USE_AIKAR_FLAGS=true',
      `MAX_PLAYERS=${FREE_PLAN.maxPlayers}`,
      'OVERRIDE_SERVER_PROPERTIES=true',
      'SPAWN_PROTECTION=0',
      ...(opts.extraEnv ?? []),
    ],
    ExposedPorts: { '25565/tcp': {} },
    HostConfig: {
      // Reuse the named world volume on a rebuild; else let itzg create its own.
      ...(volumeName ? { Binds: [`${volumeName}:/data`] } : {}),
      Memory: cap * 1024 * 1024,
      MemorySwap: cap * 1024 * 1024, // no swap spill — host swap is full
      NanoCpus: Math.round(FREE_PLAN.cpus * 1e9),
      PortBindings: { '25565/tcp': [{ HostIp: '0.0.0.0', HostPort: String(s.port) }] },
      RestartPolicy: { Name: 'no' }, // the panel owns power state, not the daemon
      PidsLimit: 512,
      SecurityOpt: ['no-new-privileges'],
    },
  };
}

// Create the container (does not start it), seeding the Velocity backend config if
// asked. Split from the start so a caller can drop plugins/config into the fresh
// /data volume — chiefly the lobby's selector — before the first boot.
export async function create(s: Server, opts: BackendOpts = {}): Promise<void> {
  await docker.createContainer(createSpec(s, undefined, opts));
  if (opts.velocitySecret) {
    const dir = await dataDir(s.id);
    if (dir) writeVelocityConfig(dir, opts.velocitySecret);
  }
}

export async function createAndStart(s: Server, opts: BackendOpts = {}): Promise<void> {
  await create(s, opts);
  await start(s.id);
}

// Rebuild an existing server's container so a changed setting (chiefly online-mode,
// which only the env sets) takes effect — keeping its world. The /data volume is
// found by name and re-mounted into the new container, so nothing is lost; we never
// pass `v: true` here (that would delete the world). Used to convert a stand-alone
// server into a proxy backend and back.
export async function rebuild(s: Server, opts: BackendOpts = {}): Promise<void> {
  markExpectedStop(s.id); // recreating the container is an intentional down, not a crash
  const c = get(s.id);
  let volumeName: string | undefined;
  let wasRunning = false;
  try {
    const info = await c.inspect();
    wasRunning = info.State.Running;
    const mount = (info.Mounts || []).find((m: any) => m.Destination === '/data');
    volumeName = mount?.Name; // anonymous volumes still have a (hash) name
  } catch (e: any) {
    if (e?.statusCode !== 404) throw e;
  }
  // Write the backend config into the existing volume before the rebuild, if we can
  // reach it (a running/stopped container still has its volume mounted for inspect).
  if (opts.velocitySecret && volumeName) {
    const dir = await dataDir(s.id).catch(() => null);
    if (dir) writeVelocityConfig(dir, opts.velocitySecret);
  }
  if (wasRunning) { try { await c.stop({ t: 40 }); } catch { /* already down */ } }
  try { await c.remove({ force: true, v: false }); } catch (e: any) { if (e?.statusCode !== 404) throw e; }

  const created = await docker.createContainer(createSpec(s, volumeName, opts));
  // Brand-new volume (there was no prior container) still needs the config seeded.
  if (opts.velocitySecret && !volumeName) {
    const dir = await dataDir(s.id);
    if (dir) writeVelocityConfig(dir, opts.velocitySecret);
  }
  // Only bring it back up if it was up before — converting a stopped server leaves
  // it stopped (reconfigured), so nothing is started that the operator hadn't.
  if (wasRunning) await created.start();
}

// Turn on Paper's Velocity modern forwarding in a server's /data volume: enable it
// and write the shared secret, so the backend trusts players the proxy forwards.
// Patches the existing paper-global.yml in place (keeping other settings); writes a
// minimal valid one if the server has never booted. Files are handed to uid 1000 so
// Paper can rewrite them on load.
export function writeVelocityConfig(volumePath: string, secret: string): void {
  const configDir = join(volumePath, 'config');
  const file = join(configDir, 'paper-global.yml');
  try {
    if (existsSync(file)) {
      let text = readFileSync(file, 'utf8');
      const before = text;
      text = text
        .replace(/(\n {2}velocity:\n(?: {4}[^\n]*\n)*? {4}enabled: )(?:true|false)/, '$1true')
        .replace(/(\n {2}velocity:\n(?: {4}[^\n]*\n)*? {4}secret: )'[^']*'/, `$1'${secret}'`);
      // If the structure wasn't what we expected, fall back to a minimal doc Paper
      // will merge defaults into rather than silently leaving forwarding off.
      if (!/\n {2}velocity:\n(?: {4}[^\n]*\n)*? {4}enabled: true/.test(text)) text = minimalPaperGlobal(secret);
      if (text !== before) writeFileSync(file, text);
    } else {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(file, minimalPaperGlobal(secret));
    }
    chownTree(configDir);
  } catch (e: any) {
    throw new Error(`could not write Velocity config: ${e?.message || e}`);
  }
}

// Re-assert a running/stopped backend's forwarding config into its volume — called
// before every start so a hand-edit to paper-global.yml can't quietly drop the
// server off the network. online-mode is forced separately by the ONLINE_MODE env +
// OVERRIDE_SERVER_PROPERTIES, which itzg rewrites into server.properties each boot.
export async function applyBackendConfig(id: string, secret: string): Promise<void> {
  const dir = await dataDir(id).catch(() => null);
  if (dir) writeVelocityConfig(dir, secret);
}

function minimalPaperGlobal(secret: string): string {
  return `# Written by Endhost so this server joins the Velocity network. Paper fills in\n# every other setting with its defaults on load.\nproxies:\n  bungee-cord:\n    online-mode: true\n  proxy-protocol: false\n  velocity:\n    enabled: true\n    online-mode: true\n    secret: '${secret}'\n`;
}

export async function start(id: string): Promise<void> {
  await get(id).start();
}

export async function stop(id: string): Promise<void> {
  markExpectedStop(id); // a panel-initiated shutdown, not a crash
  // itzg traps SIGTERM and saves; give it real time before the kill.
  await get(id).stop({ t: 40 });
}

export async function restart(id: string): Promise<void> {
  markExpectedStop(id); // the brief down in the middle is expected
  await get(id).restart({ t: 40 });
}

export async function remove(id: string): Promise<void> {
  markExpectedStop(id);
  await get(id).remove({ force: true, v: true }); // container and its world volume
}

export async function state(id: string): Promise<LiveState> {
  try {
    const info = await get(id).inspect();
    return {
      exists: true,
      running: info.State.Running,
      health: info.State.Health?.Status ?? null,
      startedAt: info.State.StartedAt ?? null,
      oomKilled: info.State.OOMKilled,
      exitCode: info.State.Running ? null : (info.State.ExitCode ?? null),
    };
  } catch (e: any) {
    if (e?.statusCode === 404) return { exists: false, running: false, health: null, startedAt: null, oomKilled: false, exitCode: null };
    throw e;
  }
}

export interface Stats {
  cpuPct: number;
  memBytes: number;
  memLimit: number;
}

export async function stats(id: string): Promise<Stats | null> {
  try {
    const raw: any = await get(id).stats({ stream: false });
    const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
    const sysDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
    const cpus = raw.cpu_stats.online_cpus || 1;
    const cpuPct = sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
    const cache = raw.memory_stats.stats?.inactive_file ?? 0;
    const memBytes = (raw.memory_stats.usage ?? 0) - cache;
    return { cpuPct: Math.max(0, cpuPct), memBytes: Math.max(0, memBytes), memLimit: raw.memory_stats.limit ?? 0 };
  } catch {
    return null;
  }
}

// Strip colour (…m) plus any other CSI or two-char escape a log line might carry.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>NOc]/g;

// Console lines the panel's own RCON polling produces — pure noise to an operator.
const RCON_NOISE = /Thread RCON Client .* (started|shutting down)$/;

// Raised when RCON can't be reached yet — almost always the boot window before the
// server process has opened its RCON port. Lets the caller say "still starting"
// instead of leaking rcon-cli's raw Go dial error to the panel.
export class RconError extends Error {
  code: 'starting';
  constructor(message: string) { super(message); this.code = 'starting'; }
}

// rcon-cli writes a Go dial error to stdout (exit 0) when the server hasn't opened
// its RCON port — the first ~20-40s of a boot, or a container that is up but whose
// JVM is still loading. These are the shapes that error takes.
const RCON_NOT_READY = /failed to connect to rcon|connection refused|dial tcp|no such host|i\/o timeout|\bEOF\b/i;

async function rconOnce(id: string, command: string): Promise<string> {
  const exec = await get(id).exec({
    Cmd: ['rcon-cli', command],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = (await exec.start({ Tty: true })) as Duplex;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8').replace(ANSI, '').trim();
}

// Run one console command through the server's own RCON and return what it said.
// A booting server refuses RCON for a short window; retry a few times, then throw
// a clean RconError rather than handing back the daemon's dial error verbatim.
export async function rcon(id: string, command: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const out = await rconOnce(id, command);
    if (!RCON_NOT_READY.test(out)) return out;
    if (attempt >= 2) throw new RconError('The server is still starting — the console will be ready in a few seconds.');
    await new Promise((r) => setTimeout(r, 350));
  }
}

// Type one command straight into the server's real console over the container's
// stdin (created with OpenStdin) — the same keystrokes an operator at the terminal
// would send. There is nothing to read back here on purpose: the command runs as
// the console command source, so its output lands in the normal log stream (see
// follow), exactly as it would on a real server console. A newline inside the text
// would smuggle in a second console line, so any are collapsed to spaces.
export async function send(id: string, command: string): Promise<void> {
  const c = get(id);
  const stream = (await c.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true })) as Duplex;
  stream.write(command.replace(/[\r\n]+/g, ' ') + '\n');
  await new Promise((r) => setTimeout(r, 120)); // let the write flush before detaching
  stream.end();
}

// Whether this server's container was created with an open stdin — i.e. whether the
// real console (send) can reach it. Containers created before the live console
// existed have it off; the panel falls back to RCON for them until a (re)start
// rebuilds the container with stdin open.
export async function consoleReady(id: string): Promise<boolean> {
  try { return !!(await get(id).inspect()).Config?.OpenStdin; }
  catch { return false; }
}

// "There are 3 of a max of 20 players online: a, b, c"
export interface PlayerList {
  online: number;
  max: number;
  names: string[];
}

export async function players(id: string): Promise<PlayerList> {
  const out = await rcon(id, 'list');
  const m = out.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)/i);
  if (!m) return { online: 0, max: FREE_PLAN.maxPlayers, names: [] };
  const names = m[3].trim() ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { online: Number(m[1]), max: Number(m[2]), names };
}

// Follow the console. Returns a stop() that detaches the stream. The container
// has no TTY, so docker frames stdout/stderr — demux both into one sink and
// split it into whole lines before handing them up.
export async function follow(id: string, onLine: (text: string) => void, tail = 250): Promise<() => void> {
  const raw = (await get(id).logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail,
    timestamps: false,
  })) as unknown as Duplex;

  const sink = new PassThrough();
  docker.modem.demuxStream(raw, sink, sink);

  let buf = '';
  const onData = (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      // The panel polls player counts over RCON; each poll makes the server log a
      // "Thread RCON Client … started / shutting down" pair. That is our own noise,
      // not something the operator did — drop it so the console stays readable.
      if (RCON_NOISE.test(line)) continue;
      onLine(line.replace(ANSI, ''));
    }
  };
  sink.on('data', onData);
  return () => {
    raw.destroy?.();
    sink.destroy?.();
  };
}

// Where a server's /data volume lives on the host. The itzg image declares
// /data as a VOLUME, so Docker mounts an anonymous volume there at create time;
// this returns its host path (present even while the container is stopped) so the
// file manager can read and write the world, configs, plugins and mods directly.
// null if the container — and therefore its volume — does not exist yet.
export async function dataDir(id: string): Promise<string | null> {
  try {
    const info = await get(id).inspect();
    const mount = (info.Mounts || []).find((m: any) => m.Destination === '/data');
    return mount?.Source ?? null;
  } catch (e: any) {
    if (e?.statusCode === 404) return null;
    throw e;
  }
}

export async function imagePresent(): Promise<boolean> {
  const list = await docker.listImages({ filters: { reference: [IMAGE] } });
  return list.length > 0;
}

// Every container this panel has ever created, by the id we stamped on it. Used
// at boot to find ones the datastore no longer knows about.
export async function listManaged(): Promise<string[]> {
  const list = await docker.listContainers({ all: true, filters: { label: ['endhost.managed=1'] } });
  return list.map((c) => c.Labels['endhost.id']).filter(Boolean);
}
