// The panel's view of the API. Every call maps to one real endpoint; a non-2xx
// carries the server's own message, which the UI shows verbatim rather than
// inventing one.

export interface Plan { id: string; name: string; ramMB: number; heapMB: number; containerMB: number; cpus: number; maxPlayers: number; }
export interface SoftwareOpt { id: string; label: string; kind: 'plugins' | 'mods' | 'vanilla'; note: string; minVersion: string; versions: string[]; }
export interface PremiumIcon { id: string; price: number; label: string; }
export interface Meta { versions: string[]; defaultVersion: string; defaultSoftware: string; software: SoftwareOpt[]; plan: Plan; joinHost: string; itemIcons: string[]; premiumIcons: PremiumIcon[]; }
export interface Capacity { running: number; maxConcurrent: number; total: number; maxTotal: number; accepting: boolean; }

export interface ServerSummary {
  id: string; name: string; version: string; software: string; softwareLabel: string; kind: string;
  address: string; port: number;
  motd: string; createdAt: number; plan: string; ramMB: number; maxPlayers: number;
  alwaysOn: boolean; subdomain: string | null; customDomain: string | null;
  icon: string; listed: boolean; lobbyStartable: boolean;
}

// ---- network / server selector ----
export interface NetworkServer {
  id: string; name: string; icon: string; address: string;
  software: string; softwareLabel: string; version: string; motd: string;
  running: boolean; online: number; maxPlayers: number;
}
export interface NetworkInfo {
  network: { enabled: boolean; provisioned: boolean; motd: string; address: string; running: boolean; backends: number };
  servers: NetworkServer[];
  online: number;
}
export interface AdminNetworkServer {
  id: string; name: string; owner: string; icon: string; listed: boolean;
  running: boolean; online: number; software: string; version: string; subdomain: string | null; inProxy: boolean;
}
export interface AdminProxy {
  provisioned: boolean; exists: boolean; running: boolean; port: number; backends: number; address: string; motd: string;
}
// The EndhostProxy network settings — the maintenance switch, both MOTDs, the kick line and
// the maintenance whitelist. Separate from the host-wide MaintenanceInfo below.
export interface NetSettings { maintenance: boolean; motdNormal: string; motdMaintenance: string; kickMessage: string; whitelist: string[]; }
export interface AdminNetworkInfo { proxy: AdminProxy; net: NetSettings; servers: AdminNetworkServer[]; }
export type ProxyAction = 'up' | 'down' | 'destroy' | 'refresh' | 'motd';

// The rank system — one model driving prefixes, tab/nametag colour, sort weight and permissions
// across the lobby and the proxy. `players` maps a Minecraft name or UUID to a rank id.
export interface Rank { id: string; name: string; prefix: string; color: string; weight: number; permissions: string[]; }
export interface RankAssignment { key: string; rank: string; }
export interface RanksInfo { ranks: Rank[]; players: RankAssignment[]; nodes: string[]; defaultId: string; }

// Host-wide maintenance: the master switch that frees ports 25565–25580.
export interface MaintenanceInfo {
  on: boolean;
  routerPort: number;
  routerListening: boolean;
  proxyPort: number;
  proxyRunning: boolean;
  runningServers: number;
}

export interface Me { email: string; credits: number; admin: boolean; serverLimit: number; serverCount: number; mcName: string | null; mcLinked: boolean; unlockedIcons: string[]; }
export interface Tx { id: string; userId: string; delta: number; reason: string; at: number; balanceAfter: number; }
export interface CreditsInfo { balance: number; alwaysOnPerHour: number; ledger: Tx[]; }
export interface AdminUser { id: string; email: string; credits: number; admin: boolean; createdAt: number; servers: number; serverLimit: number; }
export interface LiveState { exists: boolean; running: boolean; health: string | null; startedAt: string | null; oomKilled: boolean; }
export interface Players { online: number; max: number; names: string[]; }
export interface Stats { cpuPct: number; memBytes: number; memLimit: number; }
export interface ServerDetail extends ServerSummary {
  state: LiveState; players: Players | null; stats: Stats | null; lastActive: number;
  alertsUnread: number; autoRestart: boolean;
}

export interface Alert { id: string; serverId: string; at: number; kind: string; severity: 'info' | 'warn' | 'high'; message: string; read?: boolean; }
export interface AlertsInfo { alerts: Alert[]; autoRestart: boolean; unread: number; }

export interface FileEntry { name: string; type: 'dir' | 'file'; size: number; mtime: number; }
export interface DirListing { path: string; entries: FileEntry[]; }

export interface Backup { id: string; serverId: string; createdAt: number; sizeBytes: number; note: string; }
export interface BackupList { backups: Backup[]; max: number; }

export type PlayerAction = 'op' | 'deop' | 'kick' | 'ban' | 'pardon' | 'wl-add' | 'wl-remove' | 'wl-on' | 'wl-off';
export interface Roster {
  running: boolean; online: string[]; max: number; ops: string[];
  whitelist: { enabled: boolean; names: string[] }; banned: string[];
}

export interface DnsRecordA { type: 'A'; name: string; value: string; proxied: boolean; }
export interface DnsRecordSrv { type: 'SRV'; name: string; service: string; proto: string; host: string; priority: number; weight: number; port: number; target: string; }
export interface DomainRecords { a: DnsRecordA; srv: DnsRecordSrv; }
export interface DomainInfo { domain: string | null; ip: string; port: number; records: DomainRecords | null; }
export interface DomainCheck { aOk: boolean; aRecords: string[]; expectedIp: string; srv: { target: string; port: number } | null; srvOk: boolean; port: number; ready: boolean; }

export interface GameRuleDef { key: string; label: string; help: string; }
export interface WorldSettings { difficulty: string | null; rules: Record<string, boolean>; }
export interface WorldInfo { running: boolean; rules: GameRuleDef[]; difficulties: string[]; settings: WorldSettings | null; }

export interface ScheduleActionDef { id: string; label: string; desc: string; needsCommand?: boolean; }
export interface Schedule {
  id: string; action: string; command: string | null; kind: 'interval' | 'daily';
  hours: number | null; time: string | null; enabled: boolean; note: string | null;
  trigger: string; nextRun: number; lastRun: number | null; lastResult: string | null; createdAt: number;
}
export interface SchedulesInfo { schedules: Schedule[]; actions: ScheduleActionDef[]; max: number; now: number; }
export interface NewSchedule { action: string; kind: 'interval' | 'daily'; hours?: number; time?: string; command?: string; note?: string; }

export interface MetricPoint { at: number; cpuPct: number; memBytes: number; memLimit: number; }
export interface MetricsInfo { points: MetricPoint[]; capacity: number; cpuMax: number; memLimit: number; ramMB: number; }
export interface LongPoint { at: number; cpuPct: number; memBytes: number; memLimit: number; players: number; }
export interface AnalyticsInfo { range: string; stepMs: number; points: LongPoint[]; cpuMax: number; memLimit: number; ramMB: number; maxPlayers: number; }

export interface ServerEvent { id: string; serverId: string; at: number; kind: string; detail: string; }
export interface EventsInfo { events: ServerEvent[]; }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`);
  return data as T;
}

// A raw body (file text or bytes) rather than JSON — used by the file editor and
// uploader, which the tiny global JSON parser deliberately does not accept.
async function reqRaw<T>(method: string, path: string, body: BodyInit, contentType: string): Promise<T> {
  const res = await fetch(path, { method, headers: { 'Content-Type': contentType }, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`);
  return data as T;
}

const q = (s: string) => encodeURIComponent(s);

export const api = {
  me: () => req<Me | null>('GET', '/api/me'),
  // Link a Minecraft account to this panel account (one-time code typed in-game as /link CODE).
  linkCode: () => req<{ code: string; ttlSec: number; address: string }>('POST', '/api/link/code'),
  unlink: () => req<{ ok: true }>('POST', '/api/link/unlink'),
  register: (email: string, password: string) => req<{ email: string }>('POST', '/api/auth/register', { email, password }),
  login: (email: string, password: string) => req<{ email: string }>('POST', '/api/auth/login', { email, password }),
  logout: () => req<{ ok: true }>('POST', '/api/auth/logout'),

  meta: () => req<Meta>('GET', '/api/meta'),
  capacity: () => req<Capacity>('GET', '/api/capacity'),

  servers: () => req<ServerSummary[]>('GET', '/api/servers'),
  server: (id: string) => req<ServerDetail>('GET', `/api/servers/${id}`),
  create: (name: string, version: string, motd: string, software: string) => req<ServerSummary>('POST', '/api/servers', { name, version, motd, software }),
  start: (id: string) => req<{ ok: true }>('POST', `/api/servers/${id}/start`),
  stop: (id: string) => req<{ ok: true }>('POST', `/api/servers/${id}/stop`),
  restart: (id: string) => req<{ ok: true }>('POST', `/api/servers/${id}/restart`),
  alwaysOn: (id: string, on: boolean) => req<{ ok: true; alwaysOn: boolean }>('POST', `/api/servers/${id}/always-on`, { on }),
  setSubdomain: (id: string, subdomain: string) => req<{ ok: true; subdomain: string; address: string }>('POST', `/api/servers/${id}/subdomain`, { subdomain }),
  // `sent` means it went into the real console (output arrives on the live stream);
  // `output` is only present on the legacy RCON fallback.
  command: (id: string, command: string) => req<{ output?: string; sent?: boolean }>('POST', `/api/servers/${id}/command`, { command }),
  remove: (id: string) => req<{ ok: true }>('DELETE', `/api/servers/${id}`),

  // ---- file manager ----
  filesList: (id: string, path: string) => req<DirListing>('GET', `/api/servers/${id}/files/list?path=${q(path)}`),
  fileRead: (id: string, path: string) => req<{ path: string; content: string }>('GET', `/api/servers/${id}/files/read?path=${q(path)}`),
  fileWrite: (id: string, path: string, content: string) => reqRaw<{ ok: true }>('PUT', `/api/servers/${id}/files/write?path=${q(path)}`, content, 'text/plain'),
  fileMkdir: (id: string, path: string) => req<{ ok: true }>('POST', `/api/servers/${id}/files/mkdir`, { path }),
  fileRename: (id: string, from: string, to: string) => req<{ ok: true }>('POST', `/api/servers/${id}/files/rename`, { from, to }),
  fileDelete: (id: string, path: string) => req<{ ok: true }>('POST', `/api/servers/${id}/files/delete`, { path }),
  fileUpload: (id: string, path: string, data: Blob) => reqRaw<{ ok: true; size: number }>('PUT', `/api/servers/${id}/files/upload?path=${q(path)}`, data, 'application/octet-stream'),
  fileDownloadUrl: (id: string, path: string) => `/api/servers/${id}/files/download?path=${q(path)}`,

  // ---- SFTP ----
  sftpInfo: (id: string) => req<SftpInfo>('GET', `/api/servers/${id}/sftp`),
  sftpSetPassword: (password: string) => req<{ ok: true; hasPassword: true }>('POST', '/api/sftp/password', { password }),

  // ---- backups ----
  backups: (id: string) => req<BackupList>('GET', `/api/servers/${id}/backups`),
  backupCreate: (id: string, note: string) => req<{ ok: true; backup: Backup }>('POST', `/api/servers/${id}/backups`, { note }),
  backupRestore: (id: string, bid: string) => req<{ ok: true; wasRunning: boolean }>('POST', `/api/servers/${id}/backups/${bid}/restore`),
  backupDelete: (id: string, bid: string) => req<{ ok: true }>('DELETE', `/api/servers/${id}/backups/${bid}`),
  backupDownloadUrl: (id: string, bid: string) => `/api/servers/${id}/backups/${bid}/download`,

  // ---- players ----
  roster: (id: string) => req<Roster>('GET', `/api/servers/${id}/players`),
  playerAction: (id: string, action: PlayerAction, name = '') => req<{ ok: true; output: string }>('POST', `/api/servers/${id}/players/action`, { action, name }),

  // ---- custom domain ----
  domain: (id: string) => req<DomainInfo>('GET', `/api/servers/${id}/domain`),
  domainSet: (id: string, domain: string) => req<{ ok: true; domain: string; records: DomainRecords }>('PUT', `/api/servers/${id}/domain`, { domain }),
  domainClear: (id: string) => req<{ ok: true }>('DELETE', `/api/servers/${id}/domain`),
  domainCheck: (id: string) => req<DomainCheck>('POST', `/api/servers/${id}/domain/check`),

  // ---- metrics + activity ----
  metrics: (id: string) => req<MetricsInfo>('GET', `/api/servers/${id}/metrics`),
  analytics: (id: string, range: string) => req<AnalyticsInfo>('GET', `/api/servers/${id}/analytics?range=${encodeURIComponent(range)}`),
  alerts: (id: string) => req<AlertsInfo>('GET', `/api/servers/${id}/alerts`),
  markAlertsRead: (id: string) => req<{ ok: true }>('POST', `/api/servers/${id}/alerts/read`),
  setAutoRestart: (id: string, on: boolean) => req<{ ok: true; autoRestart: boolean }>('POST', `/api/servers/${id}/auto-restart`, { on }),
  events: (id: string) => req<EventsInfo>('GET', `/api/servers/${id}/events`),

  // ---- schedules ----
  schedules: (id: string) => req<SchedulesInfo>('GET', `/api/servers/${id}/schedules`),
  scheduleCreate: (id: string, s: NewSchedule) => req<{ ok: true; schedule: Schedule }>('POST', `/api/servers/${id}/schedules`, s),
  scheduleToggle: (id: string, sid: string, enabled: boolean) => req<{ ok: true; schedule: Schedule }>('POST', `/api/servers/${id}/schedules/${sid}/toggle`, { enabled }),
  scheduleRun: (id: string, sid: string) => req<{ ok: true; result: string; schedule: Schedule }>('POST', `/api/servers/${id}/schedules/${sid}/run`),
  scheduleDelete: (id: string, sid: string) => req<{ ok: true }>('DELETE', `/api/servers/${id}/schedules/${sid}`),

  // ---- world settings ----
  world: (id: string) => req<WorldInfo>('GET', `/api/servers/${id}/world`),
  worldRule: (id: string, key: string, value: boolean) => req<{ ok: true; value: boolean; output: string }>('POST', `/api/servers/${id}/world/rule`, { key, value }),
  worldDifficulty: (id: string, difficulty: string) => req<{ ok: true; output: string }>('POST', `/api/servers/${id}/world/difficulty`, { difficulty }),
  worldQuick: (id: string, action: string) => req<{ ok: true; output: string }>('POST', `/api/servers/${id}/world/quick`, { action }),

  // ---- marketplace (Modrinth) ----
  modSearch: (id: string, query: string, offset = 0) => req<ModSearch>('GET', `/api/servers/${id}/mods/search?q=${q(query)}&offset=${offset}`),
  modInstall: (id: string, project: string, version?: string) => req<{ ok: true; filename: string; dir: string }>('POST', `/api/servers/${id}/mods/install`, { project, version }),

  // ---- network / server selector ----
  network: () => req<NetworkInfo>('GET', '/api/network'),
  setIcon: (id: string, icon: string) => req<{ ok: true; icon: string }>('PUT', `/api/servers/${id}/icon`, { icon }),
  buyIcon: (icon: string) => req<{ ok: true; icon?: string; price?: number; alreadyOwned?: boolean; balance: number; unlockedIcons: string[] }>('POST', '/api/icons/buy', { icon }),
  setListed: (id: string, listed: boolean) => req<{ ok: true; listed: boolean }>('POST', `/api/servers/${id}/listed`, { listed }),
  setLobbyStartable: (id: string, on: boolean) => req<{ ok: true; lobbyStartable: boolean }>('POST', `/api/servers/${id}/lobby-startable`, { on }),
  adminNetwork: () => req<AdminNetworkInfo>('GET', '/api/admin/network'),
  adminNetMaintenance: (on: boolean) => req<{ ok: true; maintenance: boolean }>('POST', '/api/admin/network/maintenance', { on }),
  adminNetMotd: (m: { normal?: string; maintenance?: string; kick?: string }) => req<{ ok: true }>('POST', '/api/admin/network/motd', m),
  adminNetWhitelist: (action: 'add' | 'remove' | 'set', names: string[]) => req<{ ok: true; whitelist: string[] }>('POST', '/api/admin/network/whitelist', { action, names }),
  adminProxy: (action: ProxyAction, opts: { motd?: string } = {}) => req<{ ok: true; running: boolean; backends: number }>('POST', '/api/admin/network/proxy', { action, ...opts }),
  adminRanks: () => req<RanksInfo>('GET', '/api/admin/ranks'),
  adminRankSave: (r: Partial<Rank>) => req<{ ok: true; rank: Rank }>('POST', '/api/admin/ranks', r),
  adminRankDelete: (id: string) => req<{ ok: true }>('DELETE', `/api/admin/ranks/${q(id)}`),
  adminAssignRank: (player: string, rank: string) => req<{ ok: true; players: RankAssignment[] }>('POST', '/api/admin/ranks/assign', { player, rank }),
  adminMaintenance: () => req<MaintenanceInfo>('GET', '/api/admin/maintenance'),
  adminSetMaintenance: (on: boolean) => req<{ ok: true } & MaintenanceInfo>('POST', '/api/admin/maintenance', { on }),

  // ---- proxy file manager (admin) — the Velocity volume, managed like a server's ----
  proxyFilesList: (path: string) => req<DirListing>('GET', `/api/network/files/list?path=${q(path)}`),
  proxyFileRead: (path: string) => req<{ path: string; content: string }>('GET', `/api/network/files/read?path=${q(path)}`),
  proxyFileWrite: (path: string, content: string) => reqRaw<{ ok: true }>('PUT', `/api/network/files/write?path=${q(path)}`, content, 'text/plain'),
  proxyFileMkdir: (path: string) => req<{ ok: true }>('POST', '/api/network/files/mkdir', { path }),
  proxyFileRename: (from: string, to: string) => req<{ ok: true }>('POST', '/api/network/files/rename', { from, to }),
  proxyFileDelete: (path: string) => req<{ ok: true }>('POST', '/api/network/files/delete', { path }),
  proxyFileUpload: (path: string, data: Blob) => reqRaw<{ ok: true; size: number }>('PUT', `/api/network/files/upload?path=${q(path)}`, data, 'application/octet-stream'),
  proxyFileDownloadUrl: (path: string) => `/api/network/files/download?path=${q(path)}`,

  // ---- credits / admin ----
  credits: () => req<CreditsInfo>('GET', '/api/credits'),
  adminUsers: () => req<AdminUser[]>('GET', '/api/admin/users'),
  adminGrant: (email: string, amount: number) => req<{ ok: true; email: string; balance: number }>('POST', '/api/admin/credits', { email, amount }),
  adminSetServerLimit: (email: string, limit: number) => req<{ ok: true; email: string; serverLimit: number }>('POST', '/api/admin/server-limit', { email, limit }),
  adminServers: () => req<AdminServer[]>('GET', '/api/admin/servers'),
  adminStopServer: (id: string) => req<{ ok: true }>('POST', `/api/admin/servers/${id}/stop`),
  adminDeleteServer: (id: string) => req<{ ok: true }>('DELETE', `/api/admin/servers/${id}`),
};

export interface AdminServer { id: string; name: string; subdomain: string | null; software: string; version: string; owner: string; running: boolean; exists: boolean; alwaysOn: boolean; port: number; }

export interface SftpInfo { host: string; port: number; username: string; hasPassword: boolean; enabled: boolean; }

export interface ModHit {
  projectId: string; slug: string; title: string; description: string;
  downloads: number; iconUrl: string | null; author: string; categories: string[];
}
export interface ModSearch { kind: 'plugins' | 'mods' | null; dir: string | null; version: string; hits: ModHit[]; }
