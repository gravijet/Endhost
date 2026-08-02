// Endhost — the API behind the panel. Everything a button does arrives here and
// leaves as a real docker or RCON call. Where a limit is hit, the response says
// which one and why; it never pretends an action happened.

import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createConnection } from 'node:net';
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PORT, HOST, PUBLIC_DIR, FREE_PLAN, LIMITS, JOIN_HOST, PUBLIC_IP,
  ALLOWED_VERSIONS, DEFAULT_VERSION, IDLE_SLEEP_MS, REAPER_INTERVAL_MS,
  SOFTWARE, DEFAULT_SOFTWARE, softwareById, versionsFor, SFTP, CREDITS, ADMIN_EMAIL, MCROUTER, BACKUPS,
  NETWORK, NETWORK_ICONS, DEFAULT_ICONS, ALL_ICON_IDS, PREMIUM_ICONS, isPremiumIcon, premiumIcon,
  LOBBY, LOBBY_ENV, LOBBY_PLUGINS, LOBBY_JAR, PROXY_MOTD,
  DEFAULT_RANKS, DEFAULT_RANK_ID, PERMISSION_NODES, LINK,
} from './config.js';
import { store, type Server, type Rank } from './store.js';
import * as mc from './docker.js';
import * as network from './network.js';
import * as hub from './lobby.js';
import * as files from './files.js';
import * as backups from './backups.js';
import * as players from './players.js';
import * as world from './world.js';
import * as metrics from './metrics.js';
import * as schedule from './schedule.js';
import { promises as dnsp } from 'node:dns';
import { startSftp } from './sftp.js';
import { startRouter, stopRouter, routerListening } from './mcrouter.js';
import * as modrinth from './modrinth.js';
import {
  id, hashPassword, verifyPassword, createSession, destroySession,
  currentUser, userFromCookieHeader, EMAIL_RE,
} from './auth.js';
import { randomBytes } from 'node:crypto';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // nginx sits in front
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

// ------------------------------------------------------------------ helpers
type Handler = (req: Request, res: Response) => Promise<void> | void;
const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(h(req, res)).catch(next);

function requireUser(req: Request, res: Response) {
  const u = currentUser(req);
  if (!u) {
    res.status(401).json({ error: 'Sign in first.' });
    return null;
  }
  return u;
}

function requireAdmin(req: Request, res: Response) {
  const u = requireUser(req, res); if (!u) return null;
  if (!u.admin) { res.status(403).json({ error: 'Admins only.' }); return null; }
  return u;
}

// While host-wide maintenance is engaged, nothing that would bind a Minecraft port
// or spend memory may start. Returns true (and answers 503) when it should block.
function maintenanceBlocks(res: Response): boolean {
  if (!store.getMaintenance()) return false;
  res.status(503).json({ error: 'Maintenance mode is on — Minecraft services are shut down. Turn it off in the admin Network page first.' });
  return true;
}

// How many servers an account may create: its own admin-set limit, or the plan
// default for a fresh account.
function serverLimitOf(u: { serverLimit?: number }): number {
  return u.serverLimit ?? LIMITS.defaultServersPerUser;
}

// The item a server wears in the network selector — its own if set, else a stable
// default derived from its id so a brand-new server still looks distinct.
function iconOf(s: Server): string {
  if (s.icon && ALL_ICON_IDS.includes(s.icon)) return s.icon;
  let h = 0;
  for (const ch of s.id) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  return DEFAULT_ICONS[h % DEFAULT_ICONS.length];
}

function joinAddress(s: Server): string {
  const base = `${s.subdomain}.${MCROUTER.domain}`;
  return MCROUTER.enabled && s.subdomain
    ? (MCROUTER.srv ? base : `${base}:${MCROUTER.port}`)
    : `${JOIN_HOST}:${s.port}`;
}

// The address a player types to reach the network proxy. On the default Minecraft
// port (25565) no port is needed — a bare `example.invalid` finds it — so drop it.
function proxyAddress(port: number): string {
  if (MCROUTER.srv) return MCROUTER.domain;
  return port === 25565 ? JOIN_HOST : `${JOIN_HOST}:${port}`;
}

function publicServer(s: Server) {
  const sw = softwareById(s.software) ?? softwareById('paper')!;
  // With the router on, the join address is the subdomain (bare when a wildcard
  // SRV hides the port, else with the router port). Otherwise the direct host:port.
  const address = joinAddress(s);
  return {
    id: s.id, name: s.name, version: s.version,
    software: sw.id, softwareLabel: sw.label, kind: sw.kind,
    address, subdomain: s.subdomain ?? null, customDomain: s.customDomain ?? null, port: s.port,
    motd: s.motd, createdAt: s.createdAt, plan: FREE_PLAN.name,
    ramMB: FREE_PLAN.ramMB, maxPlayers: FREE_PLAN.maxPlayers,
    alwaysOn: !!s.alwaysOn,
    icon: iconOf(s), listed: s.listed !== false,
    lobbyStartable: !!s.lobbyStartable,
  };
}

// A DNS-safe label from a server name, made unique across servers.
function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'server';
}
function assignSubdomain(name: string, exceptId?: string): string {
  const base = slugify(name);
  let label = base;
  for (let n = 2; store.subdomainTaken(label, exceptId); n++) label = `${base}-${n}`.slice(0, 30);
  return label;
}

// Is a host TCP port actually free right now? (Belt-and-braces over the DB.)
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    const done = (free: boolean) => { sock.destroy(); resolve(free); };
    sock.setTimeout(300);
    sock.once('connect', () => done(false));
    sock.once('timeout', () => done(true));
    sock.once('error', () => done(true));
  });
}

async function allocatePort(): Promise<number | null> {
  const used = store.usedPorts();
  for (let p = LIMITS.portRange.from; p <= LIMITS.portRange.to; p++) {
    if (used.has(p)) continue;
    if (await portFree(p)) return p;
  }
  return null;
}

// How many *player* servers are running. The lobby is network infrastructure, not a
// user server, so it never counts against the concurrency rail.
async function runningCount(): Promise<number> {
  const users = store.allServers().filter((s) => s.role !== 'lobby');
  const states = await Promise.all(users.map((s) => mc.state(s.id).catch(() => null)));
  return states.filter((s) => s?.running).length;
}

// ------------------------------------------------------------ small rate limit
// Enough to blunt password guessing without a dependency: N attempts per IP per
// window, counted only on the auth endpoints.
const hits = new Map<string, { n: number; until: number }>();
function rateLimit(req: Request, res: Response, max = 12, windowMs = 60_000): boolean {
  const key = req.ip || 'x';
  const now = Date.now();
  const e = hits.get(key);
  if (!e || e.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return true; }
  if (e.n >= max) { res.status(429).json({ error: 'Too many attempts. Wait a minute.' }); return false; }
  e.n++;
  return true;
}

// -------------------------------------------------------------------- auth API
app.post('/api/auth/register', wrap((req, res) => {
  if (!rateLimit(req, res)) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) return void res.status(400).json({ error: 'That email does not look right.' });
  if (password.length < 8) return void res.status(400).json({ error: 'Use at least 8 characters.' });
  if (store.userByEmail(email)) return void res.status(409).json({ error: 'That email already has an account.' });
  const { salt, hash } = hashPassword(password);
  const user = { id: id('usr'), email, salt, hash, createdAt: Date.now() };
  store.addUser(user);
  createSession(res, user.id);
  res.json({ email: user.email });
}));

app.post('/api/auth/login', wrap((req, res) => {
  if (!rateLimit(req, res)) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = store.userByEmail(email);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return void res.status(401).json({ error: 'Wrong email or password.' });
  }
  createSession(res, user.id);
  res.json({ email: user.email });
}));

app.post('/api/auth/logout', wrap((req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
}));

app.get('/api/me', wrap((req, res) => {
  const u = currentUser(req);
  res.json(u ? {
    email: u.email, credits: store.creditsOf(u.id), admin: !!u.admin,
    serverLimit: serverLimitOf(u), serverCount: store.serversOf(u.id).length,
    mcName: u.mcName ?? null, mcLinked: !!u.mcUuid,
    unlockedIcons: store.unlockedIconsOf(u.id),
  } : null);
}));

// ---- linking a Minecraft account -------------------------------------------
// The account can bind one Minecraft identity: the panel mints a one-time code, the player
// types `/link CODE` in-game, the proxy relays it through the control bridge (see
// pollProxyControl) and we record the UUID. Codes are single-use and short-lived, so a code
// seen over someone's shoulder is worthless a few minutes later.
const linkCodes = new Map<string, { userId: string; expires: number }>();
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function mintLinkCode(userId: string): string {
  for (const [c, v] of linkCodes) if (v.expires < Date.now()) linkCodes.delete(c);
  // Drop any earlier code this account was handed, so only the newest one works.
  for (const [c, v] of linkCodes) if (v.userId === userId) linkCodes.delete(c);
  let code = '';
  do {
    code = '';
    const bytes = randomBytes(LINK.codeLen);
    for (let i = 0; i < LINK.codeLen; i++) code += LINK_ALPHABET[bytes[i] % LINK_ALPHABET.length];
  } while (linkCodes.has(code));
  linkCodes.set(code, { userId, expires: Date.now() + LINK.ttlMs });
  return code;
}

app.post('/api/link/code', wrap((req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const code = mintLinkCode(u.id);
  res.json({ code, ttlSec: Math.floor(LINK.ttlMs / 1000), address: proxyAddress(store.getNetwork()?.port ?? NETWORK.port) });
}));

app.post('/api/link/unlink', wrap((req, res) => {
  const u = requireUser(req, res); if (!u) return;
  store.updateUser(u.id, { mcUuid: undefined, mcName: undefined });
  res.json({ ok: true });
}));

// The account's Guthaben: balance, the always-on price, and a recent ledger so a
// number is never unexplained.
app.get('/api/credits', wrap((req, res) => {
  const u = requireUser(req, res); if (!u) return;
  res.json({
    balance: store.creditsOf(u.id),
    alwaysOnPerHour: CREDITS.alwaysOnPerHour,
    ledger: store.ledgerOf(u.id, 30),
  });
}));

// Set (or change) the SFTP password. It is stored the same way as the login
// password — scrypt with its own salt — and turns SFTP on for every server the
// account owns. Kept deliberately separate from the login password.
app.post('/api/sftp/password', wrap((req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const password = String(req.body?.password || '');
  if (password.length < SFTP.minPasswordLength)
    return void res.status(400).json({ error: `Use at least ${SFTP.minPasswordLength} characters.` });
  const { salt, hash } = hashPassword(password);
  store.updateUser(u.id, { sftpSalt: salt, sftpHash: hash });
  res.json({ ok: true, hasPassword: true });
}));

// -------------------------------------------------------------------- admin API
// The only funding path for now: an admin tops an account up (or corrects it).
// Everything runs through the same ledger, so the balance always reconciles.
app.get('/api/admin/users', wrap((req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  res.json(store.allUsers()
    .map((u) => ({ id: u.id, email: u.email, credits: store.creditsOf(u.id), admin: !!u.admin, createdAt: u.createdAt, servers: store.serversOf(u.id).length, serverLimit: serverLimitOf(u) }))
    .sort((x, y) => y.createdAt - x.createdAt));
}));

// Raise (or lower) how many servers one account may create. Bounded by the host's
// own maxServerLimit so no single account can be handed the whole disk.
app.post('/api/admin/server-limit', wrap((req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const limit = Math.floor(Number(req.body?.limit));
  if (!Number.isFinite(limit) || limit < 1 || limit > LIMITS.maxServerLimit)
    return void res.status(400).json({ error: `Enter a whole number between 1 and ${LIMITS.maxServerLimit}.` });
  const target = store.userByEmail(email);
  if (!target) return void res.status(404).json({ error: 'No account has that email.' });
  store.updateUser(target.id, { serverLimit: limit });
  res.json({ ok: true, email: target.email, serverLimit: limit });
}));

app.post('/api/admin/credits', wrap((req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const amount = Math.floor(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount === 0) return void res.status(400).json({ error: 'Enter a non-zero whole number of credits.' });
  if (Math.abs(amount) > 1_000_000) return void res.status(400).json({ error: 'That is larger than a single adjustment allows.' });
  const target = store.userByEmail(email);
  if (!target) return void res.status(404).json({ error: 'No account has that email.' });
  const tx = store.recordTx(target.id, amount, `admin ${amount > 0 ? 'top-up' : 'adjustment'} by ${a.email}`);
  res.json({ ok: true, email: target.email, balance: tx?.balanceAfter ?? store.creditsOf(target.id) });
}));

// Every server on the host, with its owner and live state — the operator's view.
app.get('/api/admin/servers', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const rows = await Promise.all(store.allServers().map(async (s) => {
    const st = await mc.state(s.id).catch(() => null);
    const owner = store.userById(s.owner);
    return {
      id: s.id, name: s.name, subdomain: s.subdomain ?? null, software: s.software, version: s.version,
      owner: owner?.email ?? s.owner, running: !!st?.running, exists: !!st?.exists, alwaysOn: !!s.alwaysOn, port: s.port,
    };
  }));
  rows.sort((x, y) => Number(y.running) - Number(x.running) || x.name.localeCompare(y.name));
  res.json(rows);
}));

app.post('/api/admin/servers/:id/stop', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const s = store.server(req.params.id);
  if (!s) return void res.status(404).json({ error: 'No such server.' });
  await mc.stop(s.id).catch(() => {});
  res.json({ ok: true });
}));

app.delete('/api/admin/servers/:id', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const s = store.server(req.params.id);
  if (!s) return void res.status(404).json({ error: 'No such server.' });
  await mc.remove(s.id).catch(() => {});
  await backups.destroyAll(s.id).catch(() => {});
  store.dropServer(s.id);
  res.json({ ok: true });
}));

// --------------------------------------------------------------- capacity API
// Real, public counts — what the panel and landing show instead of an invented
// "50,000 servers".
app.get('/api/capacity', wrap(async (_req, res) => {
  const running = await runningCount();
  res.json({
    running,
    maxConcurrent: LIMITS.maxConcurrentRunning,
    total: store.allServers().length,
    maxTotal: LIMITS.maxTotalServers,
    accepting: store.allServers().length < LIMITS.maxTotalServers,
  });
}));

app.get('/api/meta', (_req, res) => {
  res.json({
    versions: ALLOWED_VERSIONS,
    defaultVersion: DEFAULT_VERSION,
    defaultSoftware: DEFAULT_SOFTWARE,
    software: SOFTWARE.map((sw) => ({
      id: sw.id, label: sw.label, kind: sw.kind, note: sw.note,
      minVersion: sw.minVersion, versions: versionsFor(sw.id),
    })),
    plan: FREE_PLAN,
    joinHost: JOIN_HOST,
    itemIcons: NETWORK_ICONS,
    premiumIcons: PREMIUM_ICONS,
  });
});

// ---------------------------------------------------------------- servers API
app.get('/api/servers', wrap((req, res) => {
  const u = requireUser(req, res); if (!u) return;
  res.json(store.serversOf(u.id).map(publicServer));
}));

app.post('/api/servers', wrap(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;

  const limit = serverLimitOf(u);
  if (store.serversOf(u.id).length >= limit)
    return void res.status(403).json({
      error: limit <= 1
        ? `The ${FREE_PLAN.name} plan is one server per account. An admin can raise your limit.`
        : `You've reached your limit of ${limit} servers. An admin can raise it.`,
    });
  if (store.allServers().length >= LIMITS.maxTotalServers)
    return void res.status(503).json({ error: 'Endhost is at capacity right now. Try again shortly.' });
  if ((await runningCount()) >= LIMITS.maxConcurrentRunning)
    return void res.status(503).json({ error: 'All live slots are busy. A sleeping server frees one — try in a few minutes.' });

  const name = String(req.body?.name || '').trim();
  if (!/^[\w .!-]{3,32}$/.test(name))
    return void res.status(400).json({ error: 'Name: 3–32 characters, letters, numbers, spaces.' });
  const software = String(req.body?.software || DEFAULT_SOFTWARE);
  const sw = softwareById(software);
  if (!sw) return void res.status(400).json({ error: 'Unknown server software.' });
  const version = String(req.body?.version || DEFAULT_VERSION);
  if (!ALLOWED_VERSIONS.includes(version))
    return void res.status(400).json({ error: 'Unsupported version.' });
  if (!versionsFor(software).includes(version))
    return void res.status(400).json({ error: `${sw.label} needs Minecraft ${sw.minVersion} or newer.` });
  const motd = String(req.body?.motd || name).slice(0, 59);

  if (maintenanceBlocks(res)) return;
  const port = await allocatePort();
  if (port == null) return void res.status(503).json({ error: 'No free port available.' });

  // Once the network is provisioned, every new server is born a sub-server: a
  // Velocity backend that the proxy routes to and the selector lists.
  const inNetwork = !!netSecret();
  const server: Server = {
    id: id('srv'), owner: u.id, name, version, software, port,
    rconPassword: randomBytes(16).toString('hex'),
    motd, createdAt: Date.now(), lastActive: Date.now(),
    subdomain: assignSubdomain(name),
    ...(inNetwork ? { backend: true } : {}),
  };
  store.addServer(server);
  try {
    await mc.createAndStart(server, backendOptsFor(server));
  } catch (e: any) {
    store.dropServer(server.id);
    return void res.status(500).json({ error: `Could not create the server: ${e?.message || e}` });
  }
  void network.refresh().catch(() => {}); // pick up the new backend if the proxy is up
  res.json(publicServer(server));
}));

// Ownership gate shared by every per-server route.
function owned(req: Request, res: Response): { user: NonNullable<ReturnType<typeof currentUser>>; server: Server } | null {
  const u = currentUser(req);
  if (!u) { res.status(401).json({ error: 'Sign in first.' }); return null; }
  const s = store.server(req.params.id);
  if (!s || s.owner !== u.id) { res.status(404).json({ error: 'No such server.' }); return null; }
  return { user: u, server: s };
}

app.get('/api/servers/:id', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const st = await mc.state(ok.server.id);
  let plist = null, stats = null;
  if (st.running) {
    plist = await mc.players(ok.server.id).catch(() => null);
    stats = await mc.stats(ok.server.id).catch(() => null);
    if (plist && plist.online > 0) store.touchServer(ok.server.id, { lastActive: Date.now() });
  }
  res.json({ ...publicServer(ok.server), state: st, players: plist, stats, lastActive: ok.server.lastActive, alertsUnread: store.unreadAlerts(ok.server.id), autoRestart: !!ok.server.autoRestart });
}));

app.post('/api/servers/:id/start', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  if (maintenanceBlocks(res)) return;
  const st = await mc.state(ok.server.id);
  if (st.running) return void res.json({ ok: true });
  if ((await runningCount()) >= LIMITS.maxConcurrentRunning)
    return void res.status(503).json({ error: 'All live slots are busy right now.' });
  // Self-heal: if the container is gone (daemon restart, manual removal), rebuild
  // it from the record rather than failing. The world volume is recreated fresh.
  await forceBackendConfig(ok.server);
  if (st.exists) {
    // Migrate a pre-live-console container the first time it comes up: recreate it
    // (keeping its world volume) with stdin open so its console is the real one.
    // New containers are already born this way, so this only fires once per server.
    if (!(await mc.consoleReady(ok.server.id))) await mc.rebuild(ok.server, backendOptsFor(ok.server));
    await mc.start(ok.server.id);
  } else await mc.createAndStart(ok.server, backendOptsFor(ok.server));
  store.touchServer(ok.server.id, { lastActive: Date.now() });
  store.logEvent(ok.server.id, 'start', 'started from the panel');
  network.markStarting(ok.server.id); // selector shows "Starting…" until it is really up
  void network.refresh().catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/servers/:id/stop', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const st = await mc.state(ok.server.id);
  await mc.stop(ok.server.id).catch(() => {});
  if (st.running) store.logEvent(ok.server.id, 'stop', 'stopped from the panel');
  void network.refresh().catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/servers/:id/restart', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  if (maintenanceBlocks(res)) return;
  await forceBackendConfig(ok.server);
  const st = await mc.state(ok.server.id);
  if (!st.exists) {
    await mc.createAndStart(ok.server, backendOptsFor(ok.server));
  } else if (!(await mc.consoleReady(ok.server.id))) {
    // Also the moment to migrate an old container to the real console — recreate it
    // (world kept) with stdin open, then make sure it ends up running.
    await mc.rebuild(ok.server, backendOptsFor(ok.server));
    if (!(await mc.state(ok.server.id)).running) await mc.start(ok.server.id);
  } else {
    await mc.restart(ok.server.id);
  }
  store.touchServer(ok.server.id, { lastActive: Date.now() });
  store.logEvent(ok.server.id, 'restart', 'restarted from the panel');
  network.markRestarting(ok.server.id); // selector shows "Restarting…" until it is back up
  void network.refresh().catch(() => {});
  res.json({ ok: true });
}));

// Choose the subdomain players join by. Validated to a DNS label and kept unique.
app.post('/api/servers/:id/subdomain', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const raw = String(req.body?.subdomain || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(raw))
    return void res.status(400).json({ error: 'Use 2–30 letters, numbers or dashes; no leading, trailing or lone dash.' });
  if (store.subdomainTaken(raw, ok.server.id))
    return void res.status(409).json({ error: 'That subdomain is already taken.' });
  store.touchServer(ok.server.id, { subdomain: raw });
  res.json({ ok: true, subdomain: raw, address: `${raw}.${MCROUTER.domain}` });
}));

// A custom domain the owner controls and points here by DNS. The router matches it
// exactly like a subdomain (both arrive as the handshake host), so once the records
// exist a player joins by the bare name. We never touch anyone's DNS — we record
// the name, hand back the exact records to create, and can check what it resolves to.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function domainRecords(domain: string) {
  return {
    a: { type: 'A', name: domain, value: PUBLIC_IP, proxied: false },
    srv: { type: 'SRV', name: `_minecraft._tcp.${domain}`, service: '_minecraft', proto: '_tcp',
           host: domain, priority: 0, weight: 0, port: MCROUTER.port, target: domain },
  };
}

app.get('/api/servers/:id/domain', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const domain = ok.server.customDomain ?? null;
  res.json({ domain, ip: PUBLIC_IP, port: MCROUTER.port, records: domain ? domainRecords(domain) : null });
}));

app.put('/api/servers/:id/domain', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const domain = String(req.body?.domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!DOMAIN_RE.test(domain))
    return void res.status(400).json({ error: 'Enter a domain like mc.yourname.com — no http, no slash.' });
  if (domain === MCROUTER.domain || domain.endsWith('.' + MCROUTER.domain))
    return void res.status(400).json({ error: `Use a domain you own, not ${MCROUTER.domain}. Your ${MCROUTER.domain} address is set on the subdomain above.` });
  if (store.customDomainTaken(domain, ok.server.id))
    return void res.status(409).json({ error: 'Another server is already using that domain.' });
  store.touchServer(ok.server.id, { customDomain: domain });
  store.logEvent(ok.server.id, 'domain', `custom domain set to ${domain}`);
  res.json({ ok: true, domain, records: domainRecords(domain) });
}));

app.delete('/api/servers/:id/domain', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  store.touchServer(ok.server.id, { customDomain: undefined });
  res.json({ ok: true });
}));

// What the domain currently resolves to, checked live against public DNS — so the
// panel can say "your records are live" for real instead of taking it on faith.
app.post('/api/servers/:id/domain/check', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const domain = ok.server.customDomain;
  if (!domain) return void res.status(409).json({ error: 'Set a domain first.' });

  let aRecords: string[] = [];
  try { aRecords = await dnsp.resolve4(domain); } catch { /* NXDOMAIN / not set yet */ }
  const aOk = aRecords.includes(PUBLIC_IP);

  let srv: { target: string; port: number } | null = null;
  try {
    const recs = await dnsp.resolveSrv(`_minecraft._tcp.${domain}`);
    if (recs.length) srv = { target: recs[0].name.replace(/\.$/, ''), port: recs[0].port };
  } catch { /* no SRV — fine, they can still join with the port */ }
  const srvOk = !!srv && srv.port === MCROUTER.port;

  res.json({ aOk, aRecords, expectedIp: PUBLIC_IP, srv, srvOk, port: MCROUTER.port, ready: aOk });
}));

// ------------------------------------------------------------------- world API
// Difficulty and gamerules live in the world's level.dat, so these changes stick
// across restarts. Reading needs a running server (the values come back over RCON);
// asleep, the panel shows the controls but says to start it first. See world.ts.
app.get('/api/servers/:id/world', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const st = await mc.state(ok.server.id);
  res.json({
    running: st.running,
    rules: world.GAME_RULES,
    difficulties: world.DIFFICULTIES,
    settings: st.running ? await world.read(ok.server.id).catch(() => null) : null,
  });
}));

function worldErr(res: Response, e: any) {
  if (e instanceof mc.RconError) return void res.status(425).json({ error: e.message });
  res.status(500).json({ error: `That change didn't go through: ${e?.message || e}` });
}

app.post('/api/servers/:id/world/rule', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const key = String(req.body?.key || '');
  const value = !!req.body?.value;
  if (!world.validRule(key)) return void res.status(400).json({ error: 'Unknown setting.' });
  const st = await mc.state(ok.server.id);
  if (!st.running) return void res.status(409).json({ error: 'Start the server to change world settings.' });
  try { res.json({ ok: true, value, output: await world.setRule(ok.server.id, key, value) }); }
  catch (e) { worldErr(res, e); }
}));

app.post('/api/servers/:id/world/difficulty', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const d = String(req.body?.difficulty || '');
  if (!world.validDifficulty(d)) return void res.status(400).json({ error: 'Unknown difficulty.' });
  const st = await mc.state(ok.server.id);
  if (!st.running) return void res.status(409).json({ error: 'Start the server to change difficulty.' });
  try { res.json({ ok: true, output: await world.setDifficulty(ok.server.id, d) }); }
  catch (e) { worldErr(res, e); }
}));

app.post('/api/servers/:id/world/quick', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const action = String(req.body?.action || '');
  if (!world.validQuick(action)) return void res.status(400).json({ error: 'Unknown action.' });
  const st = await mc.state(ok.server.id);
  if (!st.running) return void res.status(409).json({ error: 'Start the server first.' });
  try { res.json({ ok: true, output: await world.runQuick(ok.server.id, action) }); }
  catch (e) { worldErr(res, e); }
}));

// ---------------------------------------------------------------- metrics API
// A short history of CPU and memory, sampled in the background for every running
// server (see the sampler at boot). Read back to draw the Overview graph.
app.get('/api/servers/:id/metrics', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const points = metrics.history(ok.server.id);
  res.json({
    points,
    capacity: metrics.capacity,
    cpuMax: Math.round(FREE_PLAN.cpus * 100),
    memLimit: FREE_PLAN.containerMB * 1024 * 1024,
    ramMB: FREE_PLAN.ramMB,
  });
}));

// ---------------------------------------------------------------- analytics API
// The long, persisted history for the Analytics page: players, CPU and memory over
// a day, three days or a week. Sampled every few minutes (see the sampler) and kept
// across restarts, so this is a real trend, not the last half hour redrawn.
const ANALYTICS_RANGES: Record<string, number> = { '24h': 24 * 3600e3, '3d': 3 * 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
app.get('/api/servers/:id/analytics', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const range = ANALYTICS_RANGES[String(req.query.range)] ? String(req.query.range) : '24h';
  const points = metrics.longHistory(ok.server.id, Date.now() - ANALYTICS_RANGES[range]);
  res.json({
    range,
    stepMs: metrics.LONG_STEP_MS,
    points,
    cpuMax: Math.round(FREE_PLAN.cpus * 100),
    memLimit: FREE_PLAN.containerMB * 1024 * 1024,
    ramMB: FREE_PLAN.ramMB,
    maxPlayers: FREE_PLAN.maxPlayers,
  });
}));

// --------------------------------------------------------------- activity API
// The server's recent history — power changes, backups, schedules that fired.
app.get('/api/servers/:id/events', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  res.json({ events: store.eventsOf(ok.server.id, 24) });
}));

// ------------------------------------------------------------------ alerts API
// The moments that mattered — crashes, OOM kills, auto-restarts, recoveries, high
// memory — recorded by the monitor from real container state. Plus the per-server
// auto-restart toggle.
app.get('/api/servers/:id/alerts', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  res.json({ alerts: store.alertsOf(ok.server.id, 60), autoRestart: !!ok.server.autoRestart, unread: store.unreadAlerts(ok.server.id) });
}));

app.post('/api/servers/:id/alerts/read', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  store.markAlertsRead(ok.server.id);
  res.json({ ok: true });
}));

app.post('/api/servers/:id/auto-restart', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const on = !!req.body?.on;
  store.touchServer(ok.server.id, { autoRestart: on });
  store.logEvent(ok.server.id, 'settings', `auto-restart turned ${on ? 'on' : 'off'}`);
  res.json({ ok: true, autoRestart: on });
}));

// -------------------------------------------------------------- schedules API
// Automated tasks: a nightly restart, a scheduled backup, a timed command. The
// engine (schedule.ts) fires the real action when each comes due; these routes
// only create, toggle, run-now and delete the intents.
function scheduleView(s: ReturnType<typeof store.schedule>) {
  if (!s) return null;
  return {
    id: s.id, action: s.action, command: s.command ?? null, kind: s.kind,
    hours: s.hours ?? null, time: s.time ?? null, enabled: s.enabled, note: s.note ?? null,
    trigger: schedule.describe(s), nextRun: s.nextRun, lastRun: s.lastRun ?? null, lastResult: s.lastResult ?? null,
    createdAt: s.createdAt,
  };
}

app.get('/api/servers/:id/schedules', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  res.json({
    schedules: store.schedulesOf(ok.server.id).map(scheduleView),
    actions: schedule.ACTIONS,
    max: schedule.MAX_PER_SERVER,
    now: Date.now(),
  });
}));

app.post('/api/servers/:id/schedules', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  if (store.schedulesOf(ok.server.id).length >= schedule.MAX_PER_SERVER)
    return void res.status(409).json({ error: `You can keep ${schedule.MAX_PER_SERVER} schedules per server. Delete one to make room.` });

  const action = String(req.body?.action || '');
  if (!schedule.validAction(action)) return void res.status(400).json({ error: 'Pick a task: restart, backup, start, stop or command.' });

  const kind = req.body?.kind === 'daily' ? 'daily' : 'interval';
  let hours: number | undefined, time: string | undefined;
  if (kind === 'interval') {
    hours = Math.floor(Number(req.body?.hours));
    if (!Number.isFinite(hours) || hours < 1 || hours > 168)
      return void res.status(400).json({ error: 'Interval: a whole number of hours between 1 and 168.' });
  } else {
    time = String(req.body?.time || '');
    if (!schedule.validTime(time)) return void res.status(400).json({ error: 'Time: use HH:MM, 24-hour (e.g. 04:00).' });
  }

  let command: string | undefined;
  if (action === 'command') {
    command = String(req.body?.command || '').trim().slice(0, 200);
    if (!command) return void res.status(400).json({ error: 'A command task needs a command to run.' });
  }
  const note = String(req.body?.note || '').trim().slice(0, 60) || undefined;

  const s = {
    id: id('sch'), serverId: ok.server.id, action: action as any, command,
    kind: kind as 'interval' | 'daily', hours, time, enabled: true, note,
    createdAt: Date.now(), nextRun: schedule.computeNext({ kind, hours, time }),
  };
  store.addSchedule(s);
  store.logEvent(ok.server.id, 'schedule', `added ${action} — ${schedule.describe(s)}`);
  res.json({ ok: true, schedule: scheduleView(store.schedule(s.id)) });
}));

app.post('/api/servers/:id/schedules/:sid/toggle', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const s = store.schedule(req.params.sid);
  if (!s || s.serverId !== ok.server.id) return void res.status(404).json({ error: 'No such schedule.' });
  const enabled = !!req.body?.enabled;
  // Re-arm from now when switching back on, so a long-disabled task doesn't fire immediately.
  store.updateSchedule(s.id, enabled ? { enabled, nextRun: schedule.computeNext(s) } : { enabled });
  res.json({ ok: true, schedule: scheduleView(store.schedule(s.id)) });
}));

app.post('/api/servers/:id/schedules/:sid/run', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const s = store.schedule(req.params.sid);
  if (!s || s.serverId !== ok.server.id) return void res.status(404).json({ error: 'No such schedule.' });
  let result: string;
  try { result = await schedule.runOne(s); }
  catch (e: any) { result = 'error: ' + (e?.message || String(e)).slice(0, 120); }
  store.updateSchedule(s.id, { lastRun: Date.now(), lastResult: result });
  store.logEvent(ok.server.id, 'schedule', `${s.action} (run now) — ${result}`);
  res.json({ ok: true, result, schedule: scheduleView(store.schedule(s.id)) });
}));

app.delete('/api/servers/:id/schedules/:sid', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const s = store.schedule(req.params.sid);
  if (!s || s.serverId !== ok.server.id) return void res.status(404).json({ error: 'No such schedule.' });
  store.dropSchedule(s.id);
  res.json({ ok: true });
}));

// Spend credits to keep this server awake past the idle window. Enabling needs a
// non-empty balance; the reaper bills it and switches it back off if funds run out.
app.post('/api/servers/:id/always-on', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const on = !!req.body?.on;
  if (on) {
    if (store.creditsOf(ok.user.id) < 1)
      return void res.status(402).json({ error: `Always-on costs ${CREDITS.alwaysOnPerHour} credits/hour — top up your balance first.` });
    store.touchServer(ok.server.id, { alwaysOn: true, lastCharge: Date.now() });
  } else {
    store.touchServer(ok.server.id, { alwaysOn: false });
  }
  store.logEvent(ok.server.id, 'always-on', on ? 'always-on turned on' : 'always-on turned off');
  res.json({ ok: true, alwaysOn: on });
}));

app.post('/api/servers/:id/command', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const command = String(req.body?.command || '').trim().slice(0, 256);
  if (!command) return void res.status(400).json({ error: 'Empty command.' });
  const st = await mc.state(ok.server.id);
  if (!st.running) return void res.status(409).json({ error: 'The server is asleep. Start it first.' });
  try {
    if (await mc.consoleReady(ok.server.id)) {
      // The real console: type it in over stdin. The output comes back on the live
      // console stream (the WebSocket), not in this response — same as a terminal.
      await mc.send(ok.server.id, command);
      return void res.json({ sent: true });
    }
    // Legacy container without an open stdin (predates the live console): fall back
    // to RCON until its next restart rebuilds it with the real console.
    const out = await mc.rcon(ok.server.id, command);
    res.json({ output: out });
  } catch (e: any) {
    // A boot-window RCON refusal is expected, not an error — tell the panel to say
    // "still starting" (425 Too Early) rather than dumping a raw daemon message.
    if (e instanceof mc.RconError) return void res.status(425).json({ error: e.message });
    res.json({ output: `error: ${e?.message || e}` });
  }
}));

app.delete('/api/servers/:id', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  await mc.remove(ok.server.id).catch(() => {});
  await backups.destroyAll(ok.server.id).catch(() => {});
  metrics.clear(ok.server.id); // drop its live ring + persisted history
  store.dropServer(ok.server.id);
  void network.refresh().catch(() => {});
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- network API
// The host-wide network / server selector. GET is public — the landing and panel
// both render it — and exposes only what a player needs to pick a server: its name,
// its item icon, its join address, and how many are online. Owner routes let a
// server choose its icon and hide itself; admin routes drive the Velocity proxy.

// A tiny cache so a public, unauthenticated hit doesn't fan out RCON `list` to
// every running server on each request. The counts move slowly enough.
let netCache: { at: number; body: any } | null = null;

async function networkView() {
  const net = store.getNetwork();
  const proxySt = await network.state().catch(() => null);
  const rows = await Promise.all(store.listedServers().map(async (s) => {
    const st = await mc.state(s.id).catch(() => null);
    let online = 0, max = FREE_PLAN.maxPlayers;
    if (st?.running) {
      const p = await mc.players(s.id).catch(() => null);
      if (p) { online = p.online; max = p.max; }
    }
    const sw = softwareById(s.software) ?? softwareById('paper')!;
    return {
      id: s.id, name: s.name, icon: iconOf(s), address: joinAddress(s),
      software: sw.id, softwareLabel: sw.label, version: s.version, motd: s.motd,
      running: !!st?.running, online, maxPlayers: max,
    };
  }));
  // Sort by who's busiest: most players first, then running before asleep, then name.
  rows.sort((a, b) => b.online - a.online || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
  return {
    network: {
      enabled: !!(net && proxySt?.running),
      provisioned: !!net,
      motd: net?.motd ?? NETWORK.defaultMotd,
      address: proxyAddress(net?.port ?? NETWORK.port),
      running: !!proxySt?.running,
      backends: proxySt?.backends ?? 0,
    },
    servers: rows,
    online: rows.reduce((n, r) => n + r.online, 0),
  };
}

app.get('/api/network', wrap(async (_req, res) => {
  if (!netCache || Date.now() - netCache.at > 3000) netCache = { at: Date.now(), body: await networkView() };
  res.json(netCache.body);
}));

// Choose the item this server wears in the selector. Free icons are always allowed;
// a premium icon may only be worn once the account has bought it (unlock is account-wide).
app.put('/api/servers/:id/icon', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const icon = String(req.body?.icon || '');
  if (!ALL_ICON_IDS.includes(icon)) return void res.status(400).json({ error: 'Unknown item icon.' });
  if (isPremiumIcon(icon) && !store.ownsIcon(ok.user.id, icon)) {
    const p = premiumIcon(icon);
    return void res.status(402).json({ error: `${p?.label ?? 'That icon'} is premium — buy it in the Store first (◈ ${p?.price ?? 0}).` });
  }
  store.touchServer(ok.server.id, { icon });
  netCache = null;
  res.json({ ok: true, icon });
}));

// Buy a premium selector icon with Guthaben. One-time charge; the unlock is permanent
// and account-wide, so the icon can then dress any server the account owns. Idempotent
// against a double-click: already-owned is a no-op success, never a second charge.
app.post('/api/icons/buy', wrap((req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const icon = String(req.body?.icon || '');
  const p = premiumIcon(icon);
  if (!p) return void res.status(400).json({ error: 'That is not a premium icon.' });
  if (store.ownsIcon(u.id, icon)) {
    return void res.json({ ok: true, alreadyOwned: true, balance: store.creditsOf(u.id), unlockedIcons: store.unlockedIconsOf(u.id) });
  }
  if (!store.charge(u.id, p.price, `icon · ${p.label}`)) {
    return void res.status(402).json({ error: `Not enough Guthaben — ${p.label} costs ◈ ${p.price}, you have ◈ ${store.creditsOf(u.id)}.` });
  }
  store.unlockIcon(u.id, icon);
  res.json({ ok: true, icon, price: p.price, balance: store.creditsOf(u.id), unlockedIcons: store.unlockedIconsOf(u.id) });
}));

// Show or hide this server in the network selector and the public browser.
app.post('/api/servers/:id/listed', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const listed = !!req.body?.listed;
  store.touchServer(ok.server.id, { listed });
  netCache = null;
  void network.refresh().catch(() => {});
  res.json({ ok: true, listed });
}));

// Let players start this server from inside the lobby (its selector tile and /start). Off by
// default; the same concurrency limits as the panel still apply when it actually starts.
app.post('/api/servers/:id/lobby-startable', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const on = !!req.body?.on;
  store.touchServer(ok.server.id, { lobbyStartable: on });
  void network.refresh().catch(() => {}); // network.json carries the startable flag
  res.json({ ok: true, lobbyStartable: on });
}));

// ---- admin: the proxy itself ------------------------------------------------
app.get('/api/admin/network', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const proxySt = await network.state().catch(() => null);
  const backends = proxySt?.running ? await network.liveBackends().catch(() => []) : [];
  const rows = await Promise.all(store.allServers().map(async (s) => {
    const st = await mc.state(s.id).catch(() => null);
    const owner = store.userById(s.owner);
    let online = 0;
    if (st?.running) { const p = await mc.players(s.id).catch(() => null); if (p) online = p.online; }
    return {
      id: s.id, name: s.name, owner: owner?.email ?? s.owner, icon: iconOf(s),
      listed: s.listed !== false, running: !!st?.running, online,
      software: s.software, version: s.version, subdomain: s.subdomain ?? null,
      inProxy: backends.some((b) => b.server.id === s.id),
    };
  }));
  rows.sort((x, y) => y.online - x.online || Number(y.running) - Number(x.running) || x.name.localeCompare(y.name));
  res.json({
    proxy: {
      provisioned: proxySt?.provisioned ?? false,
      exists: proxySt?.exists ?? false,
      running: proxySt?.running ?? false,
      port: proxySt?.port ?? NETWORK.port,
      backends: proxySt?.backends ?? 0,
      address: proxyAddress(proxySt?.port ?? NETWORK.port),
      motd: store.getNetwork()?.motd ?? NETWORK.defaultMotd,
    },
    // The EndhostProxy network settings — the maintenance switch, both MOTDs, the kick line
    // and the whitelist — edited from the admin Network page.
    net: {
      maintenance: !!store.getNetwork()?.netMaintenance,
      motdNormal: store.getNetwork()?.motdNormal ?? PROXY_MOTD.normal,
      motdMaintenance: store.getNetwork()?.motdMaintenance ?? PROXY_MOTD.maintenance,
      kickMessage: store.getNetwork()?.kickMessage ?? PROXY_MOTD.kick,
      whitelist: store.getNetwork()?.whitelist ?? [],
    },
    servers: rows,
  });
}));

// ---- network orchestration: the lobby and the backends ----------------------
// The forwarding secret for the current network, if it has been provisioned.
function netSecret(): string | undefined {
  return store.getNetwork()?.secret;
}

// The docker options a server should boot with: as a Velocity backend once the
// network exists (every server is a sub-server), with the lobby's lean heap when it
// is the lobby. A server with no backend flag and no network stays stand-alone.
function backendOptsFor(s: Server): mc.BackendOpts {
  const secret = netSecret();
  if (s.role === 'lobby') {
    return { velocitySecret: secret, heapMB: LOBBY.heapMB, containerMB: LOBBY.containerMB, extraEnv: LOBBY_ENV };
  }
  return s.backend && secret ? { velocitySecret: secret } : {};
}

// Force the forwarding config into a backend's volume right before it starts, so an
// edit to paper-global.yml can't drop it off the network. online-mode is already
// forced every boot by the ONLINE_MODE env + OVERRIDE_SERVER_PROPERTIES.
async function forceBackendConfig(s: Server): Promise<void> {
  const secret = netSecret();
  if (s.backend && secret) await mc.applyBackendConfig(s.id, secret).catch(() => {});
}

// Ensure the lobby exists and is the real hub. A brand-new lobby is built from scratch; one
// that predates the hub world (no worldSeeded) is rebuilt fresh once; a seeded lobby still
// running the old third-party plugin stack is migrated in place to the first-party plugin —
// keeping its world — and an already-migrated lobby is simply woken and its network.json
// refreshed. The world is never touched once it exists.
async function ensureLobby(): Promise<Server> {
  const existing = store.lobbyServer();
  if (existing) {
    if (!existing.worldSeeded) { await rebuildLobbyFresh(existing); return store.lobbyServer() ?? existing; }
    const st = await mc.state(existing.id).catch(() => null);
    const root = st?.exists ? await mc.dataDir(existing.id).catch(() => null) : null;
    const migrated = !!root && existsSync(join(root, 'plugins', LOBBY_JAR));
    if (!migrated) { await refreshLobbyPlugins(existing); return existing; }
    if (st && !st.running) { try { await mc.start(existing.id); } catch { if (!st.exists) await mc.createAndStart(existing, backendOptsFor(existing)); } }
    await network.writeNetworkJson().catch(() => {});
    return existing;
  }
  const admin = store.userByEmail(ADMIN_EMAIL);
  const ownerId = admin?.id ?? store.allServers()[0]?.owner;
  if (!ownerId) throw new Error('No account to own the lobby yet.');
  const port = await allocatePort();
  if (port == null) throw new Error('No free port for the lobby.');
  const lobby: Server = {
    id: id('srv'), owner: ownerId, name: LOBBY.name,
    version: LOBBY.version, software: LOBBY.software, port,
    rconPassword: randomBytes(16).toString('hex'),
    motd: LOBBY.motd, createdAt: Date.now(), lastActive: Date.now(),
    subdomain: assignSubdomain(LOBBY.name), icon: LOBBY.icon,
    role: 'lobby', backend: true,
  };
  store.addServer(lobby);
  store.patchNetwork({ lobbyId: lobby.id });
  await buildLobby(lobby);
  return lobby;
}

// Keep the lobby pinned to the configured build — the plugins are fetched for exactly this
// version, and a mismatch fails to load them.
function pinLobbyVersion(lobby: Server): Server {
  if (lobby.version !== LOBBY.version || lobby.software !== LOBBY.software) {
    store.touchServer(lobby.id, { version: LOBBY.version, software: LOBBY.software });
    return { ...lobby, version: LOBBY.version, software: LOBBY.software };
  }
  return lobby;
}

// Install the lobby's plugins into its volume: the Via stack (Modrinth) plus the first-party
// EndhostLobby jar and its config, then the live network.json. World-safe — it never reads
// or writes the world/ folder — so it runs against a fresh or a live lobby volume alike.
async function installLobbyPlugins(root: string): Promise<void> {
  for (const projectId of LOBBY_PLUGINS) {
    await modrinth.install({ root, software: LOBBY.software, gameVersion: LOBBY.version, projectId })
      .catch((e: any) => console.error(`[endhost] lobby plugin ${projectId} failed:`, e?.message || e));
  }
  hub.installLobbyContent(root);          // first-party plugin + config; removes the legacy stack
  await network.writeNetworkJson().catch(() => {});
  await network.writeRanksJson().catch(() => {});
  mc.chownTree(root);
}

// Build the lobby container and install its plugins into a fresh volume, then start it. The
// hub world is expected to already exist in the volume (this never pastes one); a truly
// fresh lobby boots to a void world the operator can build in.
async function buildLobby(lobby: Server): Promise<void> {
  lobby = pinLobbyVersion(lobby);
  await mc.create(lobby, backendOptsFor(lobby));
  try {
    await installLobbyPlugins(await files.rootFor(lobby.id));
  } catch (e: any) {
    console.error('[endhost] lobby content install failed:', e?.message || e);
  }
  await mc.start(lobby.id);
  store.touchServer(lobby.id, { lastActive: Date.now() });
  console.log(`[endhost] lobby ${lobby.id} built and started`);
}

// Migrate a seeded lobby to the first-party plugin in place: stop it, swap its plugin stack
// on its existing volume (the world stays), then start it. This is what turns the old
// TAB/DeluxeMenus/… lobby into the EndhostLobby one without losing the map.
async function refreshLobbyPlugins(lobby: Server): Promise<void> {
  const st = await mc.state(lobby.id).catch(() => null);
  if (!st?.exists) { await buildLobby(lobby); return; }
  lobby = pinLobbyVersion(lobby);
  console.log(`[endhost] migrating lobby ${lobby.id} to the first-party plugin`);
  if (st.running) await mc.stop(lobby.id).catch(() => {});
  const root = await mc.dataDir(lobby.id).catch(() => null);
  if (root) {
    try { await installLobbyPlugins(root); }
    catch (e: any) { console.error('[endhost] lobby plugin swap failed:', e?.message || e); }
  }
  await forceBackendConfig(lobby);
  await mc.start(lobby.id);
  store.touchServer(lobby.id, { lastActive: Date.now() });
}

// One-time migration for a lobby created before the hub world existed: throw away its
// disposable volume and build it fresh.
async function rebuildLobbyFresh(lobby: Server): Promise<void> {
  console.log(`[endhost] rebuilding lobby ${lobby.id} fresh`);
  try { await mc.remove(lobby.id); } catch (e: any) { if (e?.statusCode !== 404) console.error('[endhost] lobby remove:', e?.message || e); }
  await buildLobby(lobby);
}

// Make every listed player server a Velocity backend, keeping its world. A running
// server is rebuilt in place (online-mode off + secret written); a stopped one is
// rebuilt but left stopped; one that never had a container is just flagged and will
// be created as a backend on its next start.
async function ensureBackends(secret: string): Promise<void> {
  for (const s of store.listedServers()) {
    if (s.role === 'lobby' || s.backend) continue;
    try {
      const st = await mc.state(s.id).catch(() => null);
      if (st?.exists) await mc.rebuild(s, { velocitySecret: secret });
      store.touchServer(s.id, { backend: true });
      store.logEvent(s.id, 'network', 'joined the Velocity network');
      console.log(`[endhost] ${s.id} converted to a network backend`);
    } catch (e: any) {
      console.error(`[endhost] could not convert ${s.id} to a backend:`, e?.message || e);
    }
  }
}

// Drive the proxy: up (provision + lobby + convert backends + start + register), down
// (stop but keep the record + config), destroy (remove the container entirely).
// Admin-only. `up` builds the whole network; the operator decides when it runs.
app.post('/api/admin/network/proxy', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const action = String(req.body?.action || '');
  const motd = req.body?.motd != null ? String(req.body.motd).slice(0, 120) : null;
  // Starting the proxy while the host is shut down would re-bind 25565 — refuse.
  if ((action === 'up' || action === 'refresh') && maintenanceBlocks(res)) return;
  try {
    if (action === 'up') {
      const net = network.provision();
      ensureRanks();                            // seed the rank ladder + operator = Owner
      if (motd) store.patchNetwork({ motd });
      await ensureLobby();                      // the default landing + hub + selector
      await ensureBackends(net.secret);         // every server becomes a sub-server
      await network.up({ onlineMode: req.body?.onlineMode !== false });
      await network.writeNetworkJson().catch(() => {});
    } else if (action === 'refresh') {
      if (motd) store.patchNetwork({ motd });
      await network.refresh();
    } else if (action === 'down') {
      await network.down();
    } else if (action === 'destroy') {
      await network.destroy();
    } else if (action === 'motd') {
      network.provision();
      if (motd != null) store.patchNetwork({ motd });
      await network.refresh();
    } else {
      return void res.status(400).json({ error: 'Unknown action.' });
    }
  } catch (e: any) {
    return void res.status(500).json({ error: `Proxy ${action} failed: ${e?.message || e}` });
  }
  netCache = null;
  const proxySt = await network.state().catch(() => null);
  res.json({ ok: true, running: !!proxySt?.running, backends: proxySt?.backends ?? 0 });
}));

// ---- admin: network settings (MOTD, maintenance, whitelist) -----------------
// These drive the EndhostProxy plugin through its config.txt. Distinct from the host-wide
// maintenance switch below: this keeps the proxy up and only changes what the server list
// shows and who may join during maintenance — it never vacates ports.
function pushProxyConfig(): void {
  const net = store.getNetwork();
  if (net) network.writeProxyConfig(net);
}

app.post('/api/admin/network/maintenance', wrap((req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const on = !!req.body?.on;
  network.provision();
  store.patchNetwork({ netMaintenance: on });
  pushProxyConfig();
  res.json({ ok: true, maintenance: on });
}));

app.post('/api/admin/network/motd', wrap((req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const clean = (v: unknown) => String(v ?? '').replace(/\r/g, '').slice(0, 200);
  const patch: Partial<{ motdNormal: string; motdMaintenance: string; kickMessage: string }> = {};
  if (req.body?.normal != null) patch.motdNormal = clean(req.body.normal);
  if (req.body?.maintenance != null) patch.motdMaintenance = clean(req.body.maintenance);
  if (req.body?.kick != null) patch.kickMessage = clean(req.body.kick);
  network.provision();
  store.patchNetwork(patch);
  pushProxyConfig();
  const net = store.getNetwork();
  res.json({ ok: true, motdNormal: net?.motdNormal, motdMaintenance: net?.motdMaintenance, kickMessage: net?.kickMessage });
}));

app.post('/api/admin/network/whitelist', wrap((req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  network.provision();
  const current = new Set(store.getNetwork()?.whitelist ?? []);
  const action = String(req.body?.action || '');
  const names = (Array.isArray(req.body?.names) ? req.body.names : [req.body?.name])
    .map((n: unknown) => String(n ?? '').trim()).filter(Boolean);
  if (action === 'set') { current.clear(); names.forEach((n: string) => current.add(n)); }
  else if (action === 'add') { names.forEach((n: string) => current.add(n)); }
  else if (action === 'remove') { names.forEach((n: string) => current.delete(n)); }
  else return void res.status(400).json({ error: 'Unknown action.' });
  const whitelist = [...current].slice(0, 200);
  store.patchNetwork({ whitelist });
  pushProxyConfig();
  res.json({ ok: true, whitelist });
}));

// ---- admin: ranks & permissions ---------------------------------------------
// One rank model, written into both the lobby and the proxy so a rank defined here governs
// prefixes, tab/nametag colour, sort weight and permissions everywhere. An older network record
// that predates ranks is seeded from the defaults on first touch.
function ensureRanks(): Rank[] {
  network.provision();
  const net = store.getNetwork()!;
  if (!net.ranks || !net.ranks.length) {
    store.patchNetwork({ ranks: DEFAULT_RANKS.map((r) => ({ ...r, permissions: [...r.permissions] })) });
  }
  if (!net.playerRanks) {
    store.patchNetwork({ playerRanks: { [ (process.env.ENDHOST_LOBBY_ADMIN || 'gravijet').toLowerCase() ]: 'owner' } });
  }
  return store.getNetwork()!.ranks!;
}

app.get('/api/admin/ranks', wrap((req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  ensureRanks();
  const net = store.getNetwork()!;
  const ranks = [...(net.ranks ?? [])].sort((x, y) => y.weight - x.weight);
  const players = Object.entries(net.playerRanks ?? {}).map(([key, rank]) => ({ key, rank })).sort((x, y) => x.key.localeCompare(y.key));
  res.json({ ranks, players, nodes: PERMISSION_NODES, defaultId: DEFAULT_RANK_ID });
}));

// Create or update a rank. An empty id creates one (id slugged from the name); an existing id
// replaces that rank in place. The default rank may be edited but never removed.
app.post('/api/admin/ranks', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  ensureRanks();
  const net = store.getNetwork()!;
  const ranks = [...(net.ranks ?? [])];
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim().slice(0, 24);
  if (!name) return void res.status(400).json({ error: 'A rank needs a name.' });
  let id = String(b.id ?? '').trim().toLowerCase();
  if (!id) {
    id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || `rank_${randomBytes(3).toString('hex')}`;
    if (ranks.some((r) => r.id === id)) id = `${id}_${randomBytes(2).toString('hex')}`;
  }
  const rank: Rank = {
    id,
    name,
    prefix: String(b.prefix ?? '').slice(0, 32),
    color: (String(b.color ?? '&7').slice(0, 8)) || '&7',
    weight: Math.max(0, Math.min(1000, Math.floor(Number(b.weight)) || 0)),
    permissions: Array.isArray(b.permissions) ? b.permissions.map((p: unknown) => String(p).trim().toLowerCase()).filter(Boolean).slice(0, 60) : [],
  };
  const i = ranks.findIndex((r) => r.id === id);
  if (i >= 0) ranks[i] = rank; else ranks.push(rank);
  if (ranks.length > 40) return void res.status(400).json({ error: 'That’s a lot of ranks — 40 is the cap.' });
  store.patchNetwork({ ranks });
  await network.pushRanks().catch(() => {});
  res.json({ ok: true, rank });
}));

app.delete('/api/admin/ranks/:id', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  ensureRanks();
  const id = String(req.params.id).toLowerCase();
  if (id === DEFAULT_RANK_ID) return void res.status(400).json({ error: 'The default rank can’t be deleted.' });
  const net = store.getNetwork()!;
  const before = net.ranks?.length ?? 0;
  const ranks = (net.ranks ?? []).filter((r) => r.id !== id);
  if (ranks.length === before) return void res.status(404).json({ error: 'No such rank.' });
  const players: Record<string, string> = { ...(net.playerRanks ?? {}) };
  for (const [k, v] of Object.entries(players)) if (v === id) delete players[k];
  store.patchNetwork({ ranks, playerRanks: players });
  await network.pushRanks().catch(() => {});
  res.json({ ok: true });
}));

// Assign a player (Minecraft name or UUID) to a rank; an empty rank (or the default) clears the
// mapping, since the default rank is the implicit fallback for everyone unassigned.
app.post('/api/admin/ranks/assign', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  ensureRanks();
  const net = store.getNetwork()!;
  const player = String(req.body?.player ?? '').trim().toLowerCase().slice(0, 40);
  if (!player) return void res.status(400).json({ error: 'Name a player.' });
  const rank = String(req.body?.rank ?? '').trim().toLowerCase();
  const players: Record<string, string> = { ...(net.playerRanks ?? {}) };
  if (!rank || rank === DEFAULT_RANK_ID) {
    delete players[player];
  } else {
    if (!(net.ranks ?? []).some((r) => r.id === rank)) return void res.status(400).json({ error: 'No such rank.' });
    if (Object.keys(players).length >= 500 && !(player in players)) return void res.status(400).json({ error: 'Too many assignments.' });
    players[player] = rank;
  }
  store.patchNetwork({ playerRanks: players });
  await network.pushRanks().catch(() => {});
  res.json({ ok: true, players: Object.entries(players).map(([key, r]) => ({ key, rank: r })) });
}));

// ---- admin: host-wide maintenance (free ports 25565–25580) ------------------
// One switch that vacates every Minecraft-facing service this panel runs — the
// Velocity proxy (25565), the subdomain router (25580) and every running server —
// so the whole 25565–25580 range is free for the live network to reclaim. The
// panel, its API and SFTP keep running so the operator can turn things back on.
async function maintenanceState() {
  const proxySt = await network.state().catch(() => null);
  return {
    on: store.getMaintenance(),
    routerPort: MCROUTER.port,
    routerListening: routerListening(),
    proxyPort: proxySt?.port ?? NETWORK.port,
    proxyRunning: !!proxySt?.running,
    runningServers: await runningCount().catch(() => 0),
  };
}

app.get('/api/admin/maintenance', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  res.json(await maintenanceState());
}));

app.post('/api/admin/maintenance', wrap(async (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  const on = !!req.body?.on;
  if (on) {
    // Stop the proxy (frees 25565), close the router (frees 25580), then stop every
    // running server (hands its memory back). Order doesn't matter; all are best-effort
    // so one failure never leaves the switch half-thrown.
    await network.down().catch(() => {});
    await stopRouter();
    for (const s of store.allServers()) {
      try { if ((await mc.state(s.id)).running) await mc.stop(s.id); } catch { /* keep going */ }
    }
    store.setMaintenance(true);
    console.log('[endhost] maintenance ON — ports 25565–25580 freed by operator');
  } else {
    store.setMaintenance(false);
    // Bring the always-on entry (the router) back; the proxy and servers stay off
    // until the operator starts them, so nothing grabs memory unasked.
    startRouter({ wake: (s) => void wakeOnJoin(s) });
    console.log('[endhost] maintenance OFF — MC router back on :' + MCROUTER.port);
  }
  netCache = null;
  res.json({ ok: true, ...(await maintenanceState()) });
}));

// ------------------------------------------------------------------- sftp API
// Connection details the panel shows for this server. The username a client
// types is the server's own id; the password is the account's SFTP password.
app.get('/api/servers/:id/sftp', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  res.json({
    host: SFTP.publicHost,
    port: SFTP.port,
    username: ok.server.id,
    hasPassword: !!ok.user.sftpHash,
    enabled: SFTP.enabled,
  });
}));

// ------------------------------------------------------------------ files API
// The web file manager: real fs operations on the server's /data volume, every
// path confined to it. See files.ts. Works whether the server is awake or asleep.
function fileErr(res: Response, e: any) {
  if (e instanceof files.FileError) return void res.status(e.status).json({ error: e.message });
  console.error('[endhost] file op:', e?.message || e);
  if (!res.headersSent) res.status(500).json({ error: 'That file operation failed.' });
}

app.get('/api/servers/:id/files/list', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    res.json(await files.list(root, String(req.query.path || '')));
  } catch (e) { fileErr(res, e); }
}));

app.get('/api/servers/:id/files/read', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    res.json(await files.readText(root, String(req.query.path || '')));
  } catch (e) { fileErr(res, e); }
}));

// The editor saves plain text (path in the query); kept off express.json so a big
// config isn't clipped by the tiny global JSON limit.
app.put('/api/servers/:id/files/write', express.text({ type: '*/*', limit: '4mb' }), wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    await files.writeText(root, String(req.query.path || ''), typeof req.body === 'string' ? req.body : '');
    res.json({ ok: true });
  } catch (e) { fileErr(res, e); }
}));

app.post('/api/servers/:id/files/mkdir', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    await files.mkdir(root, String(req.body?.path || ''));
    res.json({ ok: true });
  } catch (e) { fileErr(res, e); }
}));

app.post('/api/servers/:id/files/rename', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    await files.rename(root, String(req.body?.from || ''), String(req.body?.to || ''));
    res.json({ ok: true });
  } catch (e) { fileErr(res, e); }
}));

app.post('/api/servers/:id/files/delete', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    await files.remove(root, String(req.body?.path || ''));
    res.json({ ok: true });
  } catch (e) { fileErr(res, e); }
}));

// Upload streams the raw request body to the target path (octet-stream, so the
// global JSON parser leaves the stream intact).
app.put('/api/servers/:id/files/upload', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    const target = String(req.query.path || '');
    if (!target) throw new files.FileError('No destination given.', 400);
    const { size } = await files.saveUpload(root, target, req);
    res.json({ ok: true, size });
  } catch (e) { fileErr(res, e); }
}));

app.get('/api/servers/:id/files/download', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    const info = await files.statFile(root, String(req.query.path || ''));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Content-Disposition', `attachment; filename="${info.name.replace(/[""\\\r\n]/g, '_')}"`);
    files.openRead(info.full).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
  } catch (e) { fileErr(res, e); }
}));

// ------------------------------------------------------------ proxy files API
// The Velocity proxy is a manageable server too: an admin can browse and edit its whole
// /server volume (velocity.toml, the plugins, EndhostProxy's config) the same way as any
// server's volume — same confinement, same text/binary rules. Admin only; the proxy fronts
// the entire host. Its console is the WebSocket at /api/network/console.
app.get('/api/network/files/list', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await files.list(network.proxyRoot(), String(req.query.path || ''))); }
  catch (e) { fileErr(res, e); }
}));

app.get('/api/network/files/read', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await files.readText(network.proxyRoot(), String(req.query.path || ''))); }
  catch (e) { fileErr(res, e); }
}));

app.put('/api/network/files/write', express.text({ type: '*/*', limit: '4mb' }), wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await files.writeText(network.proxyRoot(), String(req.query.path || ''), typeof req.body === 'string' ? req.body : '');
    res.json({ ok: true });
  } catch (e) { fileErr(res, e); }
}));

app.post('/api/network/files/mkdir', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { await files.mkdir(network.proxyRoot(), String(req.body?.path || '')); res.json({ ok: true }); }
  catch (e) { fileErr(res, e); }
}));

app.post('/api/network/files/rename', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { await files.rename(network.proxyRoot(), String(req.body?.from || ''), String(req.body?.to || '')); res.json({ ok: true }); }
  catch (e) { fileErr(res, e); }
}));

app.post('/api/network/files/delete', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { await files.remove(network.proxyRoot(), String(req.body?.path || '')); res.json({ ok: true }); }
  catch (e) { fileErr(res, e); }
}));

app.put('/api/network/files/upload', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const target = String(req.query.path || '');
    if (!target) throw new files.FileError('No destination given.', 400);
    const { size } = await files.saveUpload(network.proxyRoot(), target, req);
    res.json({ ok: true, size });
  } catch (e) { fileErr(res, e); }
}));

app.get('/api/network/files/download', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const info = await files.statFile(network.proxyRoot(), String(req.query.path || ''));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Content-Disposition', `attachment; filename="${info.name.replace(/["\\\r\n]/g, '_')}"`);
    files.openRead(info.full).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
  } catch (e) { fileErr(res, e); }
}));

// ---------------------------------------------------------------- backups API
// Real gzipped-tar snapshots of the server's whole /data volume. Create/list/
// restore/download/delete, all gated by the disk caps in config. See backups.ts.
function backupErr(res: Response, e: any) {
  if (e instanceof backups.BackupError) return void res.status(e.status).json({ error: e.message });
  console.error('[endhost] backup:', e?.message || e);
  if (!res.headersSent) res.status(500).json({ error: 'That backup operation failed.' });
}

app.get('/api/servers/:id/backups', wrap((req, res) => {
  const ok = owned(req, res); if (!ok) return;
  res.json({ backups: backups.list(ok.server.id), max: BACKUPS.maxPerServer });
}));

app.post('/api/servers/:id/backups', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const st = await mc.state(ok.server.id);
    const b = await backups.create(ok.server, String(req.body?.note || ''), st.running);
    store.logEvent(ok.server.id, 'backup', `snapshot ${(b.sizeBytes / 1_048_576).toFixed(1)} MB${b.note ? ` — ${b.note}` : ''}`);
    res.json({ ok: true, backup: b });
  } catch (e) { backupErr(res, e); }
}));

app.post('/api/servers/:id/backups/:bid/restore', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const st = await mc.state(ok.server.id);
    const wasRunning = st.running;
    // A restore rewrites the live volume, so the server must be down for it.
    if (wasRunning) await mc.stop(ok.server.id).catch(() => {});
    await backups.restore(ok.server, req.params.bid);
    res.json({ ok: true, wasRunning });
  } catch (e) { backupErr(res, e); }
}));

app.get('/api/servers/:id/backups/:bid/download', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const info = await backups.download(ok.server.id, req.params.bid, ok.server.name);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Content-Disposition', `attachment; filename="${info.name.replace(/[""\\\r\n]/g, '_')}"`);
    backups.openRead(info.path).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
  } catch (e) { backupErr(res, e); }
}));

app.delete('/api/servers/:id/backups/:bid', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try { await backups.remove(ok.server.id, req.params.bid); res.json({ ok: true }); }
  catch (e) { backupErr(res, e); }
}));

// ---------------------------------------------------------------- players API
// The roster reads the server's own ops/whitelist/ban files, so it is true awake
// or asleep; actions are real RCON commands, which only answer while running.
app.get('/api/servers/:id/players', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const st = await mc.state(ok.server.id);
  res.json(await players.roster(ok.server.id, st.running));
}));

app.post('/api/servers/:id/players/action', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  const action = String(req.body?.action || '') as players.Action;
  const name = String(req.body?.name || '').trim();
  if (!players.commandFor(action, name)) return void res.status(400).json({ error: 'Unknown action.' });
  if (players.needsName(action) && !players.validName(name))
    return void res.status(400).json({ error: 'Enter a valid Minecraft name (letters, numbers, underscore; up to 16).' });
  const st = await mc.state(ok.server.id);
  if (!st.running) return void res.status(409).json({ error: 'The server is asleep — start it to manage players.' });
  try {
    const output = await players.act(ok.server.id, action, name);
    res.json({ ok: true, output });
  } catch (e: any) {
    if (e instanceof mc.RconError) return void res.status(425).json({ error: e.message });
    res.status(500).json({ error: `That action failed: ${e?.message || e}` });
  }
}));

// ------------------------------------------------------- marketplace (mods) API
// Real Modrinth search and one-click install into this server's own volume. See
// modrinth.ts — results are filtered to what the server can actually load, and a
// download is verified against Modrinth's published hash before it lands.
function modErr(res: Response, e: any) {
  if (e instanceof modrinth.ModrinthError) return void res.status(e.status).json({ error: e.message });
  if (e instanceof files.FileError) return void res.status(e.status).json({ error: e.message });
  console.error('[endhost] marketplace:', e?.message || e);
  if (!res.headersSent) res.status(502).json({ error: 'The marketplace is unavailable right now.' });
}

app.get('/api/servers/:id/mods/search', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const target = modrinth.targetFor(ok.server.software);
    const hits = await modrinth.search({
      software: ok.server.software, gameVersion: ok.server.version,
      query: String(req.query.q || ''), offset: Number(req.query.offset) || 0,
    });
    res.json({ kind: target?.kind ?? null, dir: target?.dir ?? null, version: ok.server.version, hits });
  } catch (e) { modErr(res, e); }
}));

app.get('/api/servers/:id/mods/versions', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const versions = await modrinth.versions({ software: ok.server.software, gameVersion: ok.server.version, projectId: String(req.query.project || '') });
    res.json({ versions });
  } catch (e) { modErr(res, e); }
}));

app.post('/api/servers/:id/mods/install', wrap(async (req, res) => {
  const ok = owned(req, res); if (!ok) return;
  try {
    const root = await files.rootFor(ok.server.id);
    const out = await modrinth.install({
      root, software: ok.server.software, gameVersion: ok.server.version,
      projectId: String(req.body?.project || ''), versionId: req.body?.version ? String(req.body.version) : undefined,
    });
    res.json({ ok: true, ...out });
  } catch (e) { modErr(res, e); }
}));

// --------------------------------------------------------------- static + SPA
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/panel', (_req, res) => res.sendFile('panel.html', { root: PUBLIC_DIR }));
app.get('/api/*', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[endhost]', err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: 'Something broke on our side.' });
});

// -------------------------------------------------------------- console (WS)
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '', 'http://x');
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) { socket.destroy(); return; }

  // The proxy's own console — real Velocity terminal (docker logs + stdin). Admins
  // only: it fronts the whole host.
  if (url.pathname === '/api/network/console') {
    if (!user.admin) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      let stop: (() => void) | null = null;
      try {
        const st = await network.state();
        if (!st.running) ws.send('[endhost] the network proxy is off — turn it on to open its console.\n');
        else stop = await network.follow((line) => { if (ws.readyState === ws.OPEN) ws.send(line + '\n'); });
      } catch (e: any) {
        ws.send(`[endhost] proxy console unavailable: ${e?.message || e}\n`);
      }
      ws.on('message', (data) => {
        const cmd = String(data).replace(/[\r\n]+$/, '').trim();
        if (cmd) network.send(cmd).catch(() => {});
      });
      ws.on('close', () => stop?.());
    });
    return;
  }

  const m = url.pathname.match(/^\/api\/servers\/([\w-]+)\/console$/);
  if (!m) { socket.destroy(); return; }
  const server = store.server(m[1]);
  // A server's console: its owner, or any admin (admins reach every console).
  if (!server || (server.owner !== user.id && !user.admin)) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, async (ws) => {
    let stop: (() => void) | null = null;
    try {
      const st = await mc.state(server.id);
      if (!st.running) {
        ws.send('[endhost] server is asleep — press Start to wake it.\n');
      } else {
        stop = await mc.follow(server.id, (line) => {
          if (ws.readyState === ws.OPEN) ws.send(line + '\n');
        });
      }
    } catch (e: any) {
      ws.send(`[endhost] console unavailable: ${e?.message || e}\n`);
    }
    // Interactive input over the socket: type it into the server's real console over
    // stdin — the output comes back on this same stream, exactly as at a terminal.
    // (Older containers without an open stdin fall back to RCON until they restart.)
    // The panel also has a POST path; this is what lets an admin type into a server
    // they don't own.
    ws.on('message', async (data) => {
      const cmd = String(data).replace(/[\r\n]+$/, '').trim();
      if (!cmd) return;
      try {
        if (await mc.consoleReady(server.id)) { await mc.send(server.id, cmd); return; }
        const out = await mc.rcon(server.id, cmd);
        if (ws.readyState === ws.OPEN && out) ws.send(out + '\n');
      } catch (e: any) {
        if (ws.readyState === ws.OPEN) ws.send(`[endhost] ${e?.message || e}\n`);
      }
    });
    ws.on('close', () => stop?.());
  });
});

// --------------------------------------------------------------- idle reaper
// The "sleeps when empty" promise, made real: an empty server past its idle
// window is stopped, and its ~1.6 GB goes straight back to the host.
async function reap() {
  for (const s of store.allServers()) {
    try {
      if (s.role === 'lobby') continue; // the hub stays up while the network is on
      const st = await mc.state(s.id);
      if (!st.running) continue;
      // Bill the always-on perk for the time since we last did; the result tells
      // us whether it is still funded.
      const keepAwake = s.alwaysOn ? billAlwaysOn(s) : false;
      const p = await mc.players(s.id).catch(() => null);
      if (p && p.online > 0) { store.touchServer(s.id, { lastActive: Date.now() }); continue; }
      if (keepAwake) continue; // paid to stay up despite being empty
      if (Date.now() - s.lastActive > IDLE_SLEEP_MS) {
        console.log(`[endhost] sleeping idle server ${s.id}`);
        await mc.stop(s.id).catch(() => {});
        void network.refresh().catch(() => {}); // drop it from the proxy + flip the selector to Offline
      }
    } catch { /* skip this pass */ }
  }
}

// Charge accrued always-on time in whole credits and advance lastCharge by exactly
// what was billed, so rounding never loses or double-charges time. Returns whether
// the perk is still active (false once the balance can't keep up).
function billAlwaysOn(s: Server): boolean {
  const rate = CREDITS.alwaysOnPerHour;
  if (rate <= 0) return true; // configured free — stay awake at no cost
  const since = s.lastCharge ?? Date.now();
  const owed = Math.floor(((Date.now() - since) / 3_600_000) * rate);
  if (owed < 1) return true; // less than one whole credit has accrued
  const pay = Math.min(owed, store.creditsOf(s.owner));
  if (pay >= 1) {
    store.charge(s.owner, pay, `always-on · ${s.name}`);
    store.touchServer(s.id, { lastCharge: since + (pay / rate) * 3_600_000 });
  }
  if (pay < owed) { // could not cover the full bill — the perk ends here
    store.touchServer(s.id, { alwaysOn: false });
    console.log(`[endhost] always-on out of credits for ${s.id} — will sleep when idle`);
    return false;
  }
  return true;
}
setInterval(reap, REAPER_INTERVAL_MS).unref();

// --------------------------------------------------------- metrics sampler
// Drop a CPU/memory point for every running server on a fixed cadence, so the
// Overview graph has real history the moment it opens. Cheap: docker stats only,
// no RCON, and only for the at-most-two servers that are actually up.
async function sampleMetrics(): Promise<void> {
  for (const s of store.allServers()) {
    try {
      const st = await mc.state(s.id);
      if (!st.running) continue;
      const now = Date.now();
      const stat = await mc.stats(s.id);
      if (stat) metrics.record(s.id, { at: now, cpuPct: stat.cpuPct, memBytes: stat.memBytes, memLimit: stat.memLimit });
      // Every few minutes, fold a coarse point into the persisted long history for
      // the Analytics page — and only then pay for a player-count query, so the long
      // series carries players over days without polling every 30s.
      if (stat && metrics.longDue(s.id, now)) {
        let players = 0;
        try { players = (await mc.players(s.id)).online; } catch { /* count unknown this pass */ }
        metrics.recordLong(s.id, { at: now, cpuPct: stat.cpuPct, memBytes: stat.memBytes, memLimit: stat.memLimit, players });
      }
    } catch { /* skip this server this pass */ }
  }
}
setInterval(() => { void sampleMetrics(); }, 30_000).unref();

// ------------------------------------------------------- alerts / crash monitor
// Watch every server's real running state between polls. A stop the panel asked for
// (mc.stop/restart/rebuild remembers it) is silent; an out-of-memory kill or an exit
// we never asked for is a crash — recorded as an alert and, if the owner opted in,
// restarted automatically with a crash-loop guard. Everything here is read off the
// container; nothing is guessed.
const lastRunning = new Map<string, boolean>();
const downUnexpected = new Set<string>();          // saw a crash/oom → a come-up is a recovery
const highMemSince = new Map<string, number>();
const lastHighMemAlert = new Map<string, number>();
const autoRestarts = new Map<string, number[]>();  // recent auto-restart times (loop guard)

async function maybeAutoRestart(s: Server): Promise<void> {
  if (!s.autoRestart || store.getMaintenance()) return;
  const now = Date.now();
  const recent = (autoRestarts.get(s.id) ?? []).filter((t) => now - t < 30 * 60_000);
  if (recent.length >= 3) {
    store.addAlert(s.id, 'auto-restart', 'warn', 'Crashed repeatedly — auto-restart is paused to avoid a crash loop. Start it by hand once it’s fixed.');
    return;
  }
  if ((await runningCount()) >= LIMITS.maxConcurrentRunning) {
    store.addAlert(s.id, 'auto-restart', 'warn', 'Wanted to auto-restart, but every live slot is busy right now.');
    return;
  }
  try {
    await forceBackendConfig(s);
    const st = await mc.state(s.id);
    if (st.exists) { if (!(await mc.consoleReady(s.id))) await mc.rebuild(s, backendOptsFor(s)); await mc.start(s.id); }
    else await mc.createAndStart(s, backendOptsFor(s));
    recent.push(now); autoRestarts.set(s.id, recent);
    downUnexpected.delete(s.id); // the auto-restart note already tells the recovery story
    store.touchServer(s.id, { lastActive: now });
    store.addAlert(s.id, 'auto-restart', 'info', 'Auto-restarted after the crash.');
    store.logEvent(s.id, 'restart', 'auto-restarted after a crash');
    network.markStarting(s.id);
    void network.refresh().catch(() => {});
  } catch (e: any) {
    store.addAlert(s.id, 'auto-restart', 'warn', `Tried to auto-restart, but it failed: ${e?.message || e}`);
  }
}

async function monitorAlerts(): Promise<void> {
  for (const s of store.allServers()) {
    let st: mc.LiveState;
    try { st = await mc.state(s.id); } catch { continue; }
    const was = lastRunning.get(s.id);
    const isRunning = st.running;
    if (was === undefined) { lastRunning.set(s.id, isRunning); continue; } // baseline; never alert on first sight

    if (was && !isRunning) {
      const expected = mc.wasExpectedStop(s.id);
      mc.clearExpectedStop(s.id);
      if (st.oomKilled) {
        store.addAlert(s.id, 'oom', 'high', 'Ran out of memory and was killed by the host. Consider fewer plugins or a smaller view-distance.');
        store.logEvent(s.id, 'alert', 'out-of-memory kill');
        downUnexpected.add(s.id);
        await maybeAutoRestart(s);
      } else if (!expected) {
        const code = st.exitCode == null ? '' : ` (exit ${st.exitCode})`;
        store.addAlert(s.id, 'crash', 'high', `Stopped unexpectedly${code} — a crash or a server-side exit, not a stop from here.`);
        store.logEvent(s.id, 'alert', 'crashed / unexpected stop');
        downUnexpected.add(s.id);
        await maybeAutoRestart(s);
      }
      highMemSince.delete(s.id);
    } else if (!was && isRunning) {
      if (downUnexpected.delete(s.id)) store.addAlert(s.id, 'online', 'info', 'Recovered and back online.');
    }

    if (isRunning) {
      mc.clearExpectedStop(s.id); // don't let a stale marker mask a future crash
      const stat = await mc.stats(s.id).catch(() => null);
      if (stat && stat.memLimit) {
        const frac = stat.memBytes / stat.memLimit;
        if (frac >= 0.92) {
          const since = highMemSince.get(s.id) ?? Date.now();
          highMemSince.set(s.id, since);
          const lastAlert = lastHighMemAlert.get(s.id) ?? 0;
          if (Date.now() - since >= 2 * 60_000 && Date.now() - lastAlert >= 30 * 60_000) {
            store.addAlert(s.id, 'high-mem', 'warn', `Memory has sat above ${Math.round(frac * 100)}% for a couple of minutes — it may be heading for an out-of-memory kill.`);
            lastHighMemAlert.set(s.id, Date.now());
          }
        } else {
          highMemSince.delete(s.id);
        }
      }
    }

    lastRunning.set(s.id, isRunning);
  }
}
setInterval(() => { void monitorAlerts(); }, 20_000).unref();

// ------------------------------------------------------- schedule engine tick
// Fire any automated task that has come due. One minute is fine granularity for
// "daily at HH:MM" and "every N hours"; runDue writes each outcome back itself.
setInterval(() => { void schedule.runDue().catch((e) => console.error('[endhost] schedule tick:', e?.message || e)); }, 60_000).unref();

// Reconcile at boot: any managed container the datastore no longer knows about
// (a crash between create and write, a wiped record) is an orphan holding memory
// for a server nobody can see. Remove it, so reality and the records agree.
async function reconcile(): Promise<void> {
  try {
    const ids = await mc.listManaged();
    for (const id of ids) {
      if (!store.server(id)) {
        console.log(`[endhost] removing orphaned container ${id}`);
        await mc.remove(id).catch(() => {});
      }
    }
  } catch (e: any) {
    console.error('[endhost] reconcile failed:', e?.message || e);
  }
}

// ------------------------------------------------------- lobby start-bridge
// Players can start a server from inside the lobby (its selector tile or /start). The lobby
// plugin drops a request file into its own volume; we pick it up here — no network port is
// opened back to the panel — start the server if its owner allowed it and a slot is free,
// then write a reply the plugin shows the player.
async function startServerFromLobby(key: string): Promise<{ ok: boolean; message: string }> {
  const s = store.allServers().find((sv) => sv.role !== 'lobby' && network.keyFor(sv) === key);
  if (!s) return { ok: false, message: 'That server no longer exists.' };
  if (!s.lobbyStartable) return { ok: false, message: "That server can't be started from the lobby." };
  const st = await mc.state(s.id).catch(() => null);
  if (st?.running) return { ok: true, message: `${s.name} is already online — open the selector to join.` };
  if ((await runningCount()) >= LIMITS.maxConcurrentRunning)
    return { ok: false, message: 'All live server slots are busy right now — try again shortly.' };
  await forceBackendConfig(s);
  if (st?.exists) await mc.start(s.id); else await mc.createAndStart(s, backendOptsFor(s));
  store.touchServer(s.id, { lastActive: Date.now() });
  store.logEvent(s.id, 'start', 'started from the lobby');
  void network.refresh().catch(() => {});
  return { ok: true, message: `${s.name} is starting — it'll show online in the selector in a moment.` };
}

async function pollLobbyStarts(): Promise<void> {
  if (store.getMaintenance()) return; // host is shut down — never auto-start
  const lobby = store.lobbyServer();
  if (!lobby) return;
  const root = await mc.dataDir(lobby.id).catch(() => null);
  if (!root) return;
  const base = join(root, 'plugins', 'EndhostLobby');
  const reqDir = join(base, 'requests'), resDir = join(base, 'responses');
  let requests: string[];
  try { requests = readdirSync(reqDir); } catch { return; } // dir not created yet
  for (const f of requests) {
    if (!f.endsWith('.req')) continue;
    const reqPath = join(reqDir, f);
    let key = '';
    try {
      for (const line of readFileSync(reqPath, 'utf8').split('\n')) {
        const i = line.indexOf('='); if (i < 0) continue;
        if (line.slice(0, i) === 'key') key = line.slice(i + 1).trim();
      }
    } catch { /* unreadable — answered with the default failure below */ }
    let result = { ok: false, message: 'That server could not be started right now.' };
    try { if (key) result = await startServerFromLobby(key); } catch { /* keep the default failure */ }
    try {
      mkdirSync(resDir, { recursive: true });
      writeFileSync(join(resDir, `${f.slice(0, -4)}.res`), `ok=${result.ok}\nmessage=${result.message}\n`);
      mc.chownTree(resDir);
    } catch { /* the player just won't get a reply */ }
    try { rmSync(reqPath, { force: true }); } catch { /* ignore */ }
  }
}
setInterval(() => { void pollLobbyStarts().catch(() => {}); }, 2000).unref();

// ------------------------------------------------------ proxy control bridge
// A player who has linked their Minecraft account can control their own servers from anywhere
// on the network: /start, /stop, /restart. The proxy plugin drops a request file into its own
// volume; we act on it here (ownership always re-checked panel-side) and write a reply. Also
// carries /link (bind a Minecraft account to this panel account) and /maintenance (staff).

// Perform an owner power action on one of their servers, returning the line the player sees.
async function controlServerFor(userId: string, key: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; message: string }> {
  const s = store.allServers().find((sv) => sv.role !== 'lobby' && network.keyFor(sv) === key);
  if (!s) return { ok: false, message: `No server called "${key}".` };
  if (s.owner !== userId) return { ok: false, message: "That server isn't yours." };
  if ((action === 'start' || action === 'restart') && store.getMaintenance())
    return { ok: false, message: 'The host is in maintenance right now — try again shortly.' };
  const st = await mc.state(s.id).catch(() => null);
  try {
    if (action === 'stop') {
      if (!st?.running) return { ok: true, message: `${s.name} is already stopped.` };
      await mc.stop(s.id);
      store.logEvent(s.id, 'stop', 'stopped in-game by the owner');
      void network.refresh().catch(() => {});
      return { ok: true, message: `${s.name} is stopping.` };
    }
    if (action === 'restart') {
      if (!st?.exists) return { ok: false, message: `${s.name} has never started — use /start.` };
      await forceBackendConfig(s);
      await mc.restart(s.id);
      store.touchServer(s.id, { lastActive: Date.now() });
      store.logEvent(s.id, 'restart', 'restarted in-game by the owner');
      network.markRestarting(s.id);
      void network.refresh().catch(() => {});
      return { ok: true, message: `${s.name} is restarting — it'll be back in the selector shortly.` };
    }
    // start
    if (st?.running) return { ok: true, message: `${s.name} is already online — open the selector to join.` };
    if ((await runningCount()) >= LIMITS.maxConcurrentRunning)
      return { ok: false, message: 'All live server slots are busy right now — try again shortly.' };
    await forceBackendConfig(s);
    if (st?.exists) await mc.start(s.id); else await mc.createAndStart(s, backendOptsFor(s));
    store.touchServer(s.id, { lastActive: Date.now() });
    store.logEvent(s.id, 'start', 'started in-game by the owner');
    network.markStarting(s.id);
    void network.refresh().catch(() => {});
    return { ok: true, message: `${s.name} is starting — it'll show online in the selector in a moment.` };
  } catch (e: any) {
    return { ok: false, message: `Couldn't ${action} ${s.name}: ${e?.message || e}` };
  }
}

// A one-line summary of a user's servers for /myservers, newest-looking first (running first).
async function listServersFor(userId: string): Promise<string> {
  const mine = store.serversOf(userId).filter((s) => s.role !== 'lobby');
  if (!mine.length) return 'servers=You have no servers yet — create one at example.invalid.';
  const rows = await Promise.all(mine.map(async (s) => {
    const st = await mc.state(s.id).catch(() => null);
    let count = 0;
    if (st?.running) { const p = await mc.players(s.id).catch(() => null); if (p) count = p.online; }
    const status = st?.running ? `online (${count})` : 'offline';
    return `${network.keyFor(s)} — ${s.name} · ${status}`;
  }));
  return 'servers=' + rows.join('||');
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

async function handleControlRequest(kv: Record<string, string>): Promise<Record<string, string>> {
  const type = (kv.type || '').trim();
  const uuid = (kv.uuid || '').trim();
  const name = (kv.name || '').trim();

  if (type === 'link') {
    const code = (kv.code || '').trim().toUpperCase();
    const entry = linkCodes.get(code);
    if (!entry || entry.expires < Date.now()) { linkCodes.delete(code); return { ok: 'false', message: "That link code is wrong or expired. Get a fresh one on your Account page." }; }
    linkCodes.delete(code);
    // Don't let two panel accounts claim the same Minecraft UUID.
    const clash = store.userByMc(uuid);
    if (clash && clash.id !== entry.userId) return { ok: 'false', message: 'That Minecraft account is already linked to another Endhost account.' };
    store.updateUser(entry.userId, { mcUuid: uuid.replace(/-/g, '').toLowerCase(), mcName: name });
    const email = store.userById(entry.userId)?.email ?? 'your account';
    return { ok: 'true', message: `Linked to ${email}. You can now /start, /stop and /restart your servers in-game.` };
  }

  if (type === 'maintenance') {
    if (!network.playerHasNode(name, uuid, 'endhost.staff')) return { ok: 'false', message: "You don't have permission for that." };
    const on = /^(on|true|1|yes)$/i.test((kv.value || '').trim());
    network.provision();
    store.patchNetwork({ netMaintenance: on });
    const net = store.getNetwork(); if (net) network.writeProxyConfig(net);
    return { ok: 'true', message: on ? 'Network maintenance is now ON — only staff and whitelisted players can join.' : 'Network maintenance is now OFF.' };
  }

  // Everything below needs a linked account.
  const user = store.userByMc(uuid, name);
  if (!user) return { ok: 'false', message: 'Link your Minecraft account first: get a code on your Account page at example.invalid, then /link CODE.' };

  if (type === 'list') return { ok: 'true', ...(parseKv(await listServersFor(user.id))) };

  if (type === 'start' || type === 'stop' || type === 'restart') {
    const key = (kv.server || '').trim().toLowerCase();
    if (!key) return { ok: 'false', message: `Name a server: /${type} <server>. See /myservers for the list.` };
    const r = await controlServerFor(user.id, key, type);
    return { ok: String(r.ok), message: r.message };
  }

  return { ok: 'false', message: 'Unknown request.' };
}

async function pollProxyControl(): Promise<void> {
  const base = network.proxyControlDir();
  const reqDir = join(base, 'requests'), resDir = join(base, 'responses');
  let requests: string[];
  try { requests = readdirSync(reqDir); } catch { return; } // dir not created yet
  for (const f of requests) {
    if (!f.endsWith('.req')) continue;
    const reqPath = join(reqDir, f);
    let out: Record<string, string> = { ok: 'false', message: 'That request could not be handled.' };
    try {
      const kv = parseKv(readFileSync(reqPath, 'utf8'));
      out = await handleControlRequest(kv);
    } catch (e: any) { out = { ok: 'false', message: 'Something went wrong handling that.' }; }
    try {
      mkdirSync(resDir, { recursive: true });
      const body = Object.entries(out).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n';
      writeFileSync(join(resDir, `${f.slice(0, -4)}.res`), body);
      mc.chownTree(resDir);
    } catch { /* the player just won't get a reply */ }
    try { rmSync(reqPath, { force: true }); } catch { /* ignore */ }
  }
}

// Keep the in-game selector honest without waiting for a topology change: re-derive every
// server's live status (offline / starting / restarting / online + player count) and, if it
// actually moved, rewrite network.json. The writer skips the disk entirely when nothing
// changed, so this is cheap even though it runs often. This is what makes a server that went
// to sleep, woke on a join, or is still booting show the right thing within a few seconds.
setInterval(() => { void network.writeNetworkJson().catch(() => {}); }, 4000).unref();

// The control bridge: owner /start·/stop·/restart, /link and /maintenance typed on the proxy
// land here as request files in the proxy volume. Same file-drop trust boundary as the lobby
// start-bridge — no inbound port. See pollProxyControl.
setInterval(() => { void pollProxyControl().catch(() => {}); }, 2000).unref();

// --------------------------------------------------------------------- boot
// A join to a sleeping server wakes it, if a live slot is free. Debounced so a
// client's reconnect attempts don't pile up starts.
const waking = new Set<string>();
async function wakeOnJoin(s: Server): Promise<void> {
  if (store.getMaintenance()) return; // host is shut down — never auto-start
  if (waking.has(s.id)) return;
  waking.add(s.id);
  setTimeout(() => waking.delete(s.id), 45_000).unref();
  try {
    const st = await mc.state(s.id);
    if (st.running) return;
    if ((await runningCount()) >= LIMITS.maxConcurrentRunning) return;
    await forceBackendConfig(s);
    if (st.exists) await mc.start(s.id); else await mc.createAndStart(s, backendOptsFor(s));
    store.touchServer(s.id, { lastActive: Date.now() });
    network.markStarting(s.id);
    void network.refresh().catch(() => {}); // register it with the proxy + show "Starting…" in the selector
    console.log(`[endhost] woke ${s.id} on a join attempt`);
  } catch (e: any) {
    console.error('[endhost] wake failed:', e?.message || e);
  }
}

// Give any pre-subdomain server a label, so the router can find it.
function backfillSubdomains(): void {
  for (const s of store.allServers()) {
    if (!s.subdomain) {
      const label = assignSubdomain(s.name, s.id);
      store.touchServer(s.id, { subdomain: label });
      console.log(`[endhost] assigned subdomain ${label}.${MCROUTER.domain} to ${s.id}`);
    }
  }
}

httpServer.listen(PORT, HOST, async () => {
  const ok = await mc.imagePresent().catch(() => false);
  console.log(`[endhost] listening on http://${HOST}:${PORT}  (image ${ok ? 'ready' : 'MISSING'})`);
  const admin = store.userByEmail(ADMIN_EMAIL);
  if (admin && !admin.admin) { store.updateUser(admin.id, { admin: true }); console.log(`[endhost] ${ADMIN_EMAIL} marked as admin`); }
  backfillSubdomains();
  // Seed the rank ladder for an already-provisioned network and push it to the volumes, so a
  // deploy that predates the rank system gets ranks.json/ranks.txt without visiting the Ranks page.
  if (store.getNetwork()) { ensureRanks(); await network.pushRanks().catch(() => {}); }
  startSftp();
  if (store.getMaintenance()) console.log('[endhost] maintenance mode is ON — MC router held down, ports 25565–25580 free');
  else startRouter({ wake: (s) => void wakeOnJoin(s) });
  await reconcile();
});
