// Each server's resource use over time, in two resolutions. The fine ring is the
// last ~30 min at 30s spacing, kept only in memory, so the Overview can draw a live
// graph; it is cheap and fine to lose on a restart. The long series is a coarse,
// downsampled history (one point every few minutes, going back a week) that also
// carries the player count, and it IS persisted to disk so the Analytics page can
// show real days-and-weeks trends across restarts. A background sampler (see
// index.ts) feeds both. Nothing here is invented — a gap in the data is a gap the
// server was actually asleep for.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

export interface Point {
  at: number;      // epoch ms
  cpuPct: number;  // 0..(cpus*100)
  memBytes: number;
  memLimit: number;
}

// ~30 min of history at one point per 30s. Bounded per server so a long-lived
// process can never grow this without limit.
const MAX_POINTS = 60;
const rings = new Map<string, Point[]>();

export function record(serverId: string, p: Point): void {
  let ring = rings.get(serverId);
  if (!ring) { ring = []; rings.set(serverId, ring); }
  ring.push(p);
  if (ring.length > MAX_POINTS) ring.splice(0, ring.length - MAX_POINTS);
}

export function history(serverId: string): Point[] {
  return rings.get(serverId) ?? [];
}

export function clear(serverId: string): void {
  rings.delete(serverId);
  dropLong(serverId);
}

export const capacity = MAX_POINTS;

// ------------------------------------------------------------- long history
// One coarse sample every LONG_STEP_MS, capped at a week's worth, persisted so the
// Analytics page survives a panel restart. Carries the player count alongside CPU
// and memory.
export interface LongPoint {
  at: number;
  cpuPct: number;
  memBytes: number;
  memLimit: number;
  players: number;
}

export const LONG_STEP_MS = 5 * 60_000;         // one point per 5 minutes
const LONG_MAX = Math.ceil((7 * 24 * 60 * 60_000) / LONG_STEP_MS); // ~7 days
const LONG_FILE = join(DATA_DIR, 'metrics-history.json');
const longRings = new Map<string, LongPoint[]>();

function loadLong(): void {
  try {
    if (!existsSync(LONG_FILE)) return;
    const raw = JSON.parse(readFileSync(LONG_FILE, 'utf8')) as Record<string, LongPoint[]>;
    for (const [id, points] of Object.entries(raw)) {
      if (Array.isArray(points)) longRings.set(id, points.slice(-LONG_MAX));
    }
  } catch {
    /* unreadable/corrupt — start with no history rather than crash the service */
  }
}
loadLong();

function persistLong(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, LongPoint[]> = {};
    for (const [id, points] of longRings) obj[id] = points;
    const tmp = LONG_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, LONG_FILE); // atomic replace
  } catch {
    /* best effort — telemetry, not something to fail a request over */
  }
}

// Whether it is time to fold another long point for this server (its last long
// sample is at least a step old). Lets the sampler poll players only when it will
// actually store the result.
export function longDue(serverId: string, now: number): boolean {
  const ring = longRings.get(serverId);
  const last = ring && ring.length ? ring[ring.length - 1].at : 0;
  return now - last >= LONG_STEP_MS;
}

export function recordLong(serverId: string, p: LongPoint): void {
  let ring = longRings.get(serverId);
  if (!ring) { ring = []; longRings.set(serverId, ring); }
  ring.push(p);
  if (ring.length > LONG_MAX) ring.splice(0, ring.length - LONG_MAX);
  persistLong();
}

// The long series since a cutoff (0 = everything kept). Read by the Analytics API.
export function longHistory(serverId: string, sinceMs = 0): LongPoint[] {
  const ring = longRings.get(serverId) ?? [];
  return sinceMs ? ring.filter((p) => p.at >= sinceMs) : ring.slice();
}

export function dropLong(serverId: string): void {
  if (longRings.delete(serverId)) persistLong();
}
