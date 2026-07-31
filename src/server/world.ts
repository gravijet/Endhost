// World settings, over RCON. Difficulty and gamerules are stored in the world's
// own level.dat, so a change here survives restarts — unlike server.properties,
// which the itzg image re-derives from the container env each boot (which is why
// there is no properties editor). Every read and write is a real console command;
// the server answers only while it is awake.

import * as mc from './docker.js';

export interface GameRuleDef { key: string; label: string; help: string; }

// Boolean gamerules only, curated to the ones a server owner actually reaches for.
// Each maps to a real vanilla gamerule name, sent verbatim to the console.
export const GAME_RULES: GameRuleDef[] = [
  { key: 'keepInventory',        label: 'Keep inventory on death', help: 'Players keep their items and XP when they die.' },
  { key: 'doDaylightCycle',      label: 'Day / night cycle',       help: 'Time moves on its own. Off freezes the sun where it is.' },
  { key: 'doWeatherCycle',       label: 'Weather cycle',           help: 'Rain and storms roll in by themselves.' },
  { key: 'doMobSpawning',        label: 'Mob spawning',            help: 'Hostile and passive mobs spawn naturally.' },
  { key: 'mobGriefing',          label: 'Mob griefing',            help: 'Creepers, endermen and the like can change blocks.' },
  { key: 'doFireTick',           label: 'Fire spread',             help: 'Fire spreads and burns out. Off makes it stay put.' },
  { key: 'doInsomnia',           label: 'Phantoms',                help: 'Phantoms come for players who have not slept.' },
  { key: 'naturalRegeneration',  label: 'Natural regeneration',    help: 'Health refills from a full hunger bar.' },
  { key: 'fallDamage',           label: 'Fall damage',             help: 'Players take damage from long falls.' },
  { key: 'showDeathMessages',    label: 'Death messages',          help: 'Announce in chat how each player died.' },
  { key: 'announceAdvancements', label: 'Announce advancements',   help: 'Broadcast a message when a player earns one.' },
  { key: 'doImmediateRespawn',   label: 'Immediate respawn',       help: 'Skip the death screen and respawn at once.' },
];

export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const;
export type Difficulty = typeof DIFFICULTIES[number];

// One-shot console commands the panel offers as buttons. Time and weather are not
// persistent settings — they are just quick fixes — but every one is a real command.
export const QUICK: Record<string, string> = {
  'time-day':      'time set day',
  'time-night':    'time set night',
  'weather-clear': 'weather clear',
  'weather-rain':  'weather rain',
};

export interface WorldSettings {
  difficulty: Difficulty | null;
  rules: Record<string, boolean>;
}

// "Gamerule keepInventory is currently set to: true" (and older phrasings).
function parseBool(out: string): boolean | null {
  const m = out.match(/(true|false)\s*$/i);
  return m ? m[1].toLowerCase() === 'true' : null;
}

export async function read(serverId: string): Promise<WorldSettings> {
  const pairs = await Promise.all(GAME_RULES.map(async (r) => {
    try { return [r.key, parseBool(await mc.rcon(serverId, `gamerule ${r.key}`))] as const; }
    catch { return [r.key, null] as const; }
  }));
  const rules: Record<string, boolean> = {};
  for (const [k, v] of pairs) if (v !== null) rules[k] = v;

  let difficulty: Difficulty | null = null;
  try {
    const out = await mc.rcon(serverId, 'difficulty');
    const m = out.match(/difficulty is (\w+)/i);
    if (m && (DIFFICULTIES as readonly string[]).includes(m[1].toLowerCase())) difficulty = m[1].toLowerCase() as Difficulty;
  } catch { /* leave null */ }

  return { difficulty, rules };
}

export function validRule(key: string): boolean { return GAME_RULES.some((r) => r.key === key); }
export function validDifficulty(d: string): d is Difficulty { return (DIFFICULTIES as readonly string[]).includes(d); }
export function validQuick(action: string): boolean { return Object.prototype.hasOwnProperty.call(QUICK, action); }

export function setRule(serverId: string, key: string, value: boolean): Promise<string> {
  return mc.rcon(serverId, `gamerule ${key} ${value ? 'true' : 'false'}`);
}
export function setDifficulty(serverId: string, d: Difficulty): Promise<string> {
  return mc.rcon(serverId, `difficulty ${d}`);
}
export function runQuick(serverId: string, action: string): Promise<string> {
  return mc.rcon(serverId, QUICK[action]);
}
