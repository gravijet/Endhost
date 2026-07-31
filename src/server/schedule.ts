// The automation engine. A schedule is a real intent — "restart every night at
// 04:00", "back up every 6 hours" — and when one comes due this fires the exact
// same docker / RCON / backup call the matching button would, records what really
// happened, and advances its next run. Nothing here reports a success it did not
// achieve: a restart on a sleeping server is 'skipped', a backup over the disk cap
// is 'error', and both are written back verbatim for the panel to show.

import { store, type Schedule, type ScheduleAction } from './store.js';
import * as mc from './docker.js';
import * as backups from './backups.js';
import { LIMITS } from './config.js';

export interface ActionDef { id: ScheduleAction; label: string; desc: string; needsCommand?: boolean; }
export const ACTIONS: ActionDef[] = [
  { id: 'restart', label: 'Restart', desc: 'Reboot the server — only if it is awake.' },
  { id: 'backup',  label: 'Backup',  desc: 'Take a world snapshot (asleep or awake).' },
  { id: 'start',   label: 'Start',   desc: 'Wake the server, if a live slot is free.' },
  { id: 'stop',    label: 'Stop',    desc: 'Put the server to sleep.' },
  { id: 'command', label: 'Command', desc: 'Run a console command over RCON.', needsCommand: true },
];

export const MAX_PER_SERVER = 6;

export function actionDef(a: string): ActionDef | undefined { return ACTIONS.find((x) => x.id === a); }
export function validAction(a: string): a is ScheduleAction { return !!actionDef(a); }
export function validTime(t: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

// When a schedule should next fire, in epoch ms. Interval schedules count from the
// moment asked; daily schedules resolve to the next HH:MM in the host's local time.
export function computeNext(s: Pick<Schedule, 'kind' | 'hours' | 'time'>, fromMs: number = Date.now()): number {
  if (s.kind === 'interval') {
    const h = Math.max(1, Math.min(168, Math.floor(s.hours || 24)));
    return fromMs + h * 3_600_000;
  }
  const [hh, mm] = (s.time || '04:00').split(':').map(Number);
  const next = new Date(fromMs);
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
  return next.getTime();
}

// A short human sentence for the trigger, for the panel.
export function describe(s: Pick<Schedule, 'kind' | 'hours' | 'time'>): string {
  if (s.kind === 'interval') { const h = s.hours || 24; return h === 1 ? 'every hour' : `every ${h} hours`; }
  return `daily at ${s.time || '04:00'}`;
}

async function runningCount(): Promise<number> {
  const states = await Promise.all(store.allServers().map((s) => mc.state(s.id).catch(() => null)));
  return states.filter((s) => s?.running).length;
}

// Perform one schedule's action against reality and return a one-line outcome.
export async function runOne(s: Schedule): Promise<string> {
  const server = store.server(s.serverId);
  if (!server) return 'error: server no longer exists';
  const st = await mc.state(s.serverId).catch(() => null);

  switch (s.action) {
    case 'restart':
      if (!st?.running) return 'skipped: server was asleep';
      await mc.restart(s.serverId);
      return 'ok: restarted';
    case 'stop':
      if (!st?.running) return 'skipped: already asleep';
      await mc.stop(s.serverId);
      return 'ok: stopped';
    case 'start':
      if (st?.running) return 'skipped: already awake';
      if ((await runningCount()) >= LIMITS.maxConcurrentRunning) return 'skipped: no free slot';
      if (st?.exists) await mc.start(s.serverId); else await mc.createAndStart(server);
      store.touchServer(s.serverId, { lastActive: Date.now() });
      return 'ok: started';
    case 'backup': {
      const b = await backups.create(server, s.note || 'scheduled backup', !!st?.running);
      return `ok: snapshot ${(b.sizeBytes / 1_048_576).toFixed(1)} MB`;
    }
    case 'command': {
      if (!st?.running) return 'skipped: server was asleep';
      const out = await mc.rcon(s.serverId, s.command || '');
      const trimmed = (out || '').replace(/\s+/g, ' ').trim();
      return `ok: ${trimmed ? trimmed.slice(0, 80) : 'command ran'}`;
    }
  }
  return 'error: unknown action';
}

// Fire every schedule that has come due. Called on a fixed tick from the server.
// One schedule's failure never stops the rest; each outcome is written back and
// logged to the server's activity feed.
export async function runDue(now: number = Date.now()): Promise<void> {
  const due = store.allSchedules().filter((s) => s.enabled && s.nextRun <= now);
  for (const s of due) {
    let result: string;
    try { result = await runOne(s); }
    catch (e: any) { result = 'error: ' + (e?.message || String(e)).slice(0, 120); }
    store.updateSchedule(s.id, { lastRun: now, lastResult: result, nextRun: computeNext(s, now) });
    const label = s.action === 'command' ? `command "${(s.command || '').slice(0, 40)}"` : s.action;
    store.logEvent(s.serverId, 'schedule', `${label} — ${result}`);
  }
}
