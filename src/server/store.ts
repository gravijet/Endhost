// A small, honest datastore: one JSON file, written atomically. No database to
// keep alive, and the whole state is inspectable by eye — which is the right
// scale for one host running a handful of servers.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

export interface User {
  id: string;
  email: string;
  salt: string;
  hash: string;
  createdAt: number;
  // A separate credential for SFTP, set in the panel. Kept apart from the login
  // password so it can be shared with an FTP client or rotated on its own, and
  // so SFTP stays off until the user deliberately turns it on. Optional: an
  // account that has never set one simply cannot use SFTP.
  sftpSalt?: string;
  sftpHash?: string;
  // Guthaben balance, in credits. Absent means zero (old records).
  credits?: number;
  // Admins can grant credits and see every account. Set on the operator account.
  admin?: boolean;
  // How many servers this account may create. Absent means the plan default
  // (LIMITS.defaultServersPerUser); an admin raises it per account.
  serverLimit?: number;
  // The Minecraft account this panel account is linked to (set with a one-time
  // /link code in-game). Once linked, the player can control their own servers
  // from anywhere on the network (/start, /stop, /restart). mcUuid is stored
  // undashed; mcName is the last name we saw for it.
  mcUuid?: string;
  mcName?: string;
}

// One movement of credits — a grant from an admin or a charge for a running
// perk. The ledger is append-only, so a balance is always explainable.
export interface Tx {
  id: string;
  userId: string;
  delta: number;      // + for a top-up, - for a charge
  reason: string;
  at: number;
  balanceAfter: number;
}

export interface Session {
  userId: string;
  createdAt: number;
}

export interface Server {
  id: string;
  owner: string;
  name: string;
  version: string;
  software: string; // a SOFTWARE id (paper/purpur/fabric/forge/vanilla)
  port: number;
  rconPassword: string;
  motd: string;
  createdAt: number;
  // Wall-clock of the last moment a player was seen online; drives idle sleep.
  lastActive: number;
  // Paid to stay awake past the idle window. While true (and the owner has
  // credits), the reaper leaves it running and bills alwaysOnPerHour by elapsed
  // time. lastCharge is when it was last billed; it resets when the perk is
  // switched on so the meter starts fresh.
  alwaysOn?: boolean;
  lastCharge?: number;
  // The label a player joins by: `<subdomain>.<domain>`. Unique across servers,
  // assigned from the name at create and editable later.
  subdomain?: string;
  // A domain the owner controls and has pointed here by DNS. The router matches it
  // the same way it matches a subdomain, so a player can join by the bare custom
  // name. Optional and unique across servers; we never touch anyone's DNS.
  customDomain?: string;
  // The Minecraft item that represents this server in the network selector — an id
  // from the panel's item set (public/assets/img/items/<icon>.png). Absent means
  // the default block icon.
  icon?: string;
  // Whether this server is shown in the network / server selector. Absent counts as
  // listed (visible); set false to hide it from the selector and the public browser.
  listed?: boolean;
  // The whole host is one Velocity network: every server is a sub-server behind the
  // proxy. `role: 'lobby'` marks the hub players land on by default (there is one).
  // `backend: true` means the container is configured for the proxy — online-mode
  // off and the modern-forwarding secret written into its Paper config — so a join
  // routed through the proxy is accepted instead of disconnected. Absent = not yet
  // converted (still a stand-alone online-mode server).
  role?: 'lobby';
  backend?: boolean;
  // Lobby only: the downloaded hub world has been pasted into the volume and its
  // spawn set. Set once, after the first boot, so it is never re-pasted; its absence
  // on an existing lobby triggers a one-time fresh rebuild with the new world.
  worldSeeded?: boolean;
  // Owner opt-in: players may start this server from inside the lobby (its selector tile
  // and `/start`), subject to the same concurrency limits as the panel. Absent = off.
  lobbyStartable?: boolean;
}

// One rank in the network-wide rank system, edited from the admin Ranks page and written into
// both the lobby (ranks.json) and the proxy (ranks.txt) so a single definition governs prefixes,
// tab/nametag colour, sort weight and permissions everywhere. `permissions` are nodes, matched
// literally, by prefix wildcard (`endhost.*`) or by the global `*`. Prefix/color carry legacy &
// colour codes. There is always a `default` rank; it is the fallback for anyone unassigned.
export interface Rank {
  id: string;
  name: string;
  prefix: string;
  color: string;
  weight: number;
  permissions: string[];
}

// The host-wide network — one big Velocity proxy that fronts the listed servers as
// sub-servers, so a player joins once and hops between them in-game. Singleton: this
// host runs at most one proxy. `running` mirrors whether the proxy container is up
// (the panel owns that state); `secret` is the modern-forwarding secret shared with
// the backends. Absent until an admin first provisions the proxy.
export interface Network {
  secret: string;
  port: number;         // the public port the proxy listens on
  motd: string;
  running: boolean;
  createdAt: number;
  lobbyId?: string;     // the server players land on by default (role: 'lobby')
  // The EndhostProxy plugin's network settings, edited from the admin Network page and
  // written into the proxy's config.txt. Two MOTDs with a toggle, a kick line for players
  // turned away during maintenance, and a whitelist that only applies while maintenance is
  // on. Absent fields fall back to the PROXY_MOTD defaults.
  motdNormal?: string;
  motdMaintenance?: string;
  kickMessage?: string;
  netMaintenance?: boolean;
  whitelist?: string[];
  // The rank system: the list of ranks, and a map of player (lowercased name or UUID) → rank id.
  // Absent until first seeded from the defaults (see config.DEFAULT_RANKS).
  ranks?: Rank[];
  playerRanks?: Record<string, string>;
}

// One saved snapshot of a server's world volume. The archive itself lives on disk
// (see backups.ts); this is just the record of it, so a list is instant and a
// balance of what exists is always explainable.
export interface Backup {
  id: string;
  serverId: string;
  createdAt: number;
  sizeBytes: number;
  note: string;
}

// An automated task the panel runs on the operator's behalf — a nightly restart,
// a scheduled backup, a command at a fixed time. Real: the engine (schedule.ts)
// fires the same docker/RCON/backup calls a button would, records the outcome, and
// advances nextRun. Two trigger kinds: every N hours, or daily at HH:MM (host time).
export type ScheduleAction = 'restart' | 'start' | 'stop' | 'backup' | 'command';
export interface Schedule {
  id: string;
  serverId: string;
  action: ScheduleAction;
  command?: string;          // for action === 'command'
  kind: 'interval' | 'daily';
  hours?: number;            // kind === 'interval': run every N hours
  time?: string;             // kind === 'daily': 'HH:MM' in host local time
  enabled: boolean;
  note?: string;
  createdAt: number;
  nextRun: number;
  lastRun?: number;
  lastResult?: string;       // 'ok: …' | 'skipped: …' | 'error: …'
}

// One line of a server's activity log — a power change, a backup, a schedule that
// fired, a domain edit. Append-only and capped, so the Overview can show a true
// recent history instead of an invented one.
export interface ServerEvent {
  id: string;
  serverId: string;
  at: number;
  kind: string;              // 'start' | 'stop' | 'restart' | 'backup' | 'schedule' | 'domain' | 'always-on' | …
  detail: string;
}

interface DB {
  users: Record<string, User>;
  sessions: Record<string, Session>;
  servers: Record<string, Server>;
  ledger: Tx[];
  backups: Backup[];
  schedules: Schedule[];
  events: ServerEvent[];
  network: Network | null;
  // Host-wide maintenance: when true the operator has shut every Minecraft-facing
  // service down (proxy, subdomain router, all servers) to free ports 25565–25580.
  // The panel/API/SFTP stay up; nothing auto-starts while this holds.
  maintenance: boolean;
}

const FILE = join(DATA_DIR, 'db.json');
const TMP = join(DATA_DIR, 'db.json.tmp');

const db: DB = load();

function load(): DB {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<DB>;
      return { users: d.users ?? {}, sessions: d.sessions ?? {}, servers: d.servers ?? {}, ledger: d.ledger ?? [], backups: d.backups ?? [], schedules: d.schedules ?? [], events: d.events ?? [], network: d.network ?? null, maintenance: d.maintenance ?? false };
    }
  } catch {
    /* corrupt or unreadable — start clean rather than crash the service */
  }
  return { users: {}, sessions: {}, servers: {}, ledger: [], backups: [], schedules: [], events: [], network: null, maintenance: false };
}

function persist(): void {
  // Synchronous and immediate. The write volume is tiny (a handful of servers),
  // and this state tracks real containers — a debounced write that a crash or a
  // kill can drop would leave the record and the daemon disagreeing about what
  // exists. Correctness beats coalescing here.
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TMP, JSON.stringify(db, null, 2));
  renameSync(TMP, FILE); // atomic replace
}

export const store = {
  // users
  userByEmail(email: string): User | undefined {
    const e = email.toLowerCase();
    return Object.values(db.users).find((u) => u.email === e);
  },
  userById(id: string): User | undefined {
    return db.users[id];
  },
  // The account linked to a Minecraft identity: by UUID first (stable), then by the
  // last-seen name as a fallback. UUIDs are compared undashed.
  userByMc(uuid: string, name?: string): User | undefined {
    const u = uuid.replace(/-/g, '').toLowerCase();
    const n = (name ?? '').toLowerCase();
    return Object.values(db.users).find((x) => (x.mcUuid && x.mcUuid.replace(/-/g, '').toLowerCase() === u))
        ?? (n ? Object.values(db.users).find((x) => (x.mcName ?? '').toLowerCase() === n && !!x.mcUuid) : undefined);
  },
  addUser(u: User): void {
    db.users[u.id] = u;
    persist();
  },
  updateUser(id: string, patch: Partial<User>): void {
    const u = db.users[id];
    if (!u) return;
    Object.assign(u, patch);
    persist();
  },

  // sessions
  addSession(id: string, s: Session): void {
    db.sessions[id] = s;
    persist();
  },
  session(id: string): Session | undefined {
    return db.sessions[id];
  },
  dropSession(id: string): void {
    delete db.sessions[id];
    persist();
  },

  // servers
  server(id: string): Server | undefined {
    return db.servers[id];
  },
  serversOf(userId: string): Server[] {
    return Object.values(db.servers).filter((s) => s.owner === userId);
  },
  allServers(): Server[] {
    return Object.values(db.servers);
  },
  // Every server that opts into the network selector (absent `listed` counts as in).
  listedServers(): Server[] {
    return Object.values(db.servers).filter((s) => s.listed !== false);
  },
  // The one hub server players land on by default, if it exists.
  lobbyServer(): Server | undefined {
    return Object.values(db.servers).find((s) => s.role === 'lobby');
  },
  usedPorts(): Set<number> {
    return new Set(Object.values(db.servers).map((s) => s.port));
  },
  serverBySubdomain(label: string): Server | undefined {
    const l = label.toLowerCase();
    return Object.values(db.servers).find((s) => (s.subdomain || '').toLowerCase() === l);
  },
  subdomainTaken(label: string, exceptId?: string): boolean {
    const l = label.toLowerCase();
    return Object.values(db.servers).some((s) => s.id !== exceptId && (s.subdomain || '').toLowerCase() === l);
  },
  serverByCustomDomain(host: string): Server | undefined {
    const h = host.toLowerCase();
    if (!h) return undefined;
    return Object.values(db.servers).find((s) => (s.customDomain || '').toLowerCase() === h);
  },
  customDomainTaken(host: string, exceptId?: string): boolean {
    const h = host.toLowerCase();
    return Object.values(db.servers).some((s) => s.id !== exceptId && (s.customDomain || '').toLowerCase() === h);
  },
  addServer(s: Server): void {
    db.servers[s.id] = s;
    persist();
  },
  touchServer(id: string, patch: Partial<Server>): void {
    const s = db.servers[id];
    if (!s) return;
    Object.assign(s, patch);
    persist();
  },
  dropServer(id: string): void {
    delete db.servers[id];
    db.schedules = db.schedules.filter((s) => s.serverId !== id);
    db.events = db.events.filter((e) => e.serverId !== id);
    persist();
  },

  // schedules
  schedulesOf(serverId: string): Schedule[] {
    return db.schedules.filter((s) => s.serverId === serverId).sort((a, b) => a.createdAt - b.createdAt);
  },
  schedule(id: string): Schedule | undefined {
    return db.schedules.find((s) => s.id === id);
  },
  allSchedules(): Schedule[] {
    return db.schedules;
  },
  addSchedule(s: Schedule): void {
    db.schedules.push(s);
    persist();
  },
  updateSchedule(id: string, patch: Partial<Schedule>): void {
    const s = db.schedules.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    persist();
  },
  dropSchedule(id: string): void {
    const i = db.schedules.findIndex((s) => s.id === id);
    if (i >= 0) { db.schedules.splice(i, 1); persist(); }
  },

  // activity log (append-only, capped globally and per server)
  logEvent(serverId: string, kind: string, detail: string): void {
    db.events.push({ id: `evt_${randomBytes(6).toString('hex')}`, serverId, at: Date.now(), kind, detail: detail.slice(0, 160) });
    const mine = db.events.filter((e) => e.serverId === serverId);
    if (mine.length > 60) {
      const drop = new Set(mine.slice(0, mine.length - 60).map((e) => e.id));
      db.events = db.events.filter((e) => !drop.has(e.id));
    }
    if (db.events.length > 4000) db.events.splice(0, db.events.length - 4000);
    persist();
  },
  eventsOf(serverId: string, limit = 20): ServerEvent[] {
    return db.events.filter((e) => e.serverId === serverId).slice(-limit).reverse();
  },

  // credits + ledger
  allUsers(): User[] {
    return Object.values(db.users);
  },
  creditsOf(userId: string): number {
    return db.users[userId]?.credits ?? 0;
  },
  // Append one credit movement and return it (null if the user is gone). Balance
  // is clamped at zero so a charge can never drive an account negative.
  recordTx(userId: string, delta: number, reason: string): Tx | null {
    const u = db.users[userId];
    if (!u) return null;
    const balanceAfter = Math.max(0, (u.credits ?? 0) + delta);
    u.credits = balanceAfter;
    const tx: Tx = { id: `tx_${randomBytes(6).toString('hex')}`, userId, delta, reason, at: Date.now(), balanceAfter };
    db.ledger.push(tx);
    if (db.ledger.length > 5000) db.ledger.splice(0, db.ledger.length - 5000);
    persist();
    return tx;
  },
  grant(userId: string, amount: number, reason: string): Tx | null {
    return this.recordTx(userId, Math.abs(amount), reason);
  },
  // Deduct amount if the balance covers it; false (and no movement) otherwise.
  charge(userId: string, amount: number, reason: string): boolean {
    const u = db.users[userId];
    if (!u || (u.credits ?? 0) < amount) return false;
    this.recordTx(userId, -Math.abs(amount), reason);
    return true;
  },
  ledgerOf(userId: string, limit = 50): Tx[] {
    return db.ledger.filter((t) => t.userId === userId).slice(-limit).reverse();
  },

  // network (the one host-wide Velocity proxy; the container is owned by network.ts)
  getNetwork(): Network | null {
    return db.network;
  },
  saveNetwork(n: Network): void {
    db.network = n;
    persist();
  },
  patchNetwork(patch: Partial<Network>): Network | null {
    if (!db.network) return null;
    Object.assign(db.network, patch);
    persist();
    return db.network;
  },

  // Host-wide maintenance switch (see DB.maintenance).
  getMaintenance(): boolean {
    return db.maintenance;
  },
  setMaintenance(on: boolean): void {
    db.maintenance = on;
    persist();
  },

  // backups (the archive files live on disk; these are the records)
  backupsOf(serverId: string): Backup[] {
    return db.backups.filter((b) => b.serverId === serverId).sort((a, b) => b.createdAt - a.createdAt);
  },
  backup(id: string): Backup | undefined {
    return db.backups.find((b) => b.id === id);
  },
  addBackup(b: Backup): void {
    db.backups.push(b);
    persist();
  },
  dropBackup(id: string): void {
    const i = db.backups.findIndex((b) => b.id === id);
    if (i >= 0) { db.backups.splice(i, 1); persist(); }
  },
  dropBackupsOf(serverId: string): void {
    const before = db.backups.length;
    db.backups = db.backups.filter((b) => b.serverId !== serverId);
    if (db.backups.length !== before) persist();
  },
};
