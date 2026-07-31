// A short, in-memory history of each server's resource use, so the Overview can
// draw a real graph instead of a single blinking number. A background sampler
// (see index.ts) reads docker stats for every running server on a fixed cadence
// and drops a point in here; the panel reads the ring back. Nothing is persisted —
// this is live telemetry, cheap to keep and fine to lose on a restart.

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
}

export const capacity = MAX_POINTS;
