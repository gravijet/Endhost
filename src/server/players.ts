// Player management, for real. Who is on the server right now comes from RCON;
// who is an operator, who is whitelisted and who is banned come from the very
// files the server reads — ops.json, whitelist.json, banned-players.json — so the
// lists are true whether the server is awake or asleep. Every action (op, kick,
// ban, whitelist) is a real RCON command, which the server only answers while it
// is running; asleep, the page shows the lists and says so rather than pretending.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { dataDir, rcon, players as onlinePlayers } from './docker.js';
import { store } from './store.js';

// A Minecraft name: 1–16 of [A-Za-z0-9_]. Also the guard against a name being used
// to smuggle extra RCON arguments.
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
export function validName(name: string): boolean { return NAME_RE.test(name); }

export interface Roster {
  running: boolean;
  online: string[];
  max: number;
  ops: string[];
  whitelist: { enabled: boolean; names: string[] };
  banned: string[];
}

async function readJsonArray(file: string): Promise<any[]> {
  try { const txt = await fs.readFile(file, 'utf8'); const v = JSON.parse(txt); return Array.isArray(v) ? v : []; }
  catch { return []; } // absent (fresh server) or unreadable → empty, not an error
}

function names(rows: any[]): string[] {
  return rows.map((r) => (typeof r === 'string' ? r : r?.name)).filter((n): n is string => !!n);
}

// white-list=true|false from server.properties (the last state the server wrote).
async function whitelistEnabled(dir: string): Promise<boolean> {
  try {
    const txt = await fs.readFile(join(dir, 'server.properties'), 'utf8');
    const m = txt.match(/^\s*white-list\s*=\s*(\w+)/m);
    return m ? m[1].toLowerCase() === 'true' : false;
  } catch { return false; }
}

export async function roster(serverId: string, running: boolean): Promise<Roster> {
  const dir = await dataDir(serverId).catch(() => null);
  const [ops, wl, banned, wlOn] = dir
    ? await Promise.all([
        readJsonArray(join(dir, 'ops.json')),
        readJsonArray(join(dir, 'whitelist.json')),
        readJsonArray(join(dir, 'banned-players.json')),
        whitelistEnabled(dir),
      ])
    : [[], [], [], false];

  let online: string[] = [];
  let max = 20;
  if (running) {
    const p = await onlinePlayers(serverId).catch(() => null);
    if (p) { online = p.names; max = p.max; }
    if (p && p.online > 0) store.touchServer(serverId, { lastActive: Date.now() });
  }

  return {
    running,
    online,
    max,
    ops: names(ops).sort((a, b) => a.localeCompare(b)),
    whitelist: { enabled: wlOn, names: names(wl).sort((a, b) => a.localeCompare(b)) },
    banned: names(banned).sort((a, b) => a.localeCompare(b)),
  };
}

export type Action = 'op' | 'deop' | 'kick' | 'ban' | 'pardon' | 'wl-add' | 'wl-remove' | 'wl-on' | 'wl-off';

// Map a UI action to the console command it really runs. Actions that name a player
// require a valid name; the two whitelist toggles do not.
export function commandFor(action: Action, name: string): string | null {
  switch (action) {
    case 'op': return `op ${name}`;
    case 'deop': return `deop ${name}`;
    case 'kick': return `kick ${name}`;
    case 'ban': return `ban ${name}`;
    case 'pardon': return `pardon ${name}`;
    case 'wl-add': return `whitelist add ${name}`;
    case 'wl-remove': return `whitelist remove ${name}`;
    case 'wl-on': return 'whitelist on';
    case 'wl-off': return 'whitelist off';
    default: return null;
  }
}

export function needsName(action: Action): boolean {
  return action !== 'wl-on' && action !== 'wl-off';
}

// Run one player action through RCON and return what the server said.
export async function act(serverId: string, action: Action, name: string): Promise<string> {
  const cmd = commandFor(action, name);
  if (!cmd) throw new Error('Unknown action.');
  return rcon(serverId, cmd);
}
