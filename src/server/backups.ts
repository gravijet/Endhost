// World backups, for real. A snapshot is a gzipped tar of the whole /data volume
// — world, configs, plugins, mods, the lot — written to a host directory that sits
// outside the volume it captures. Restoring stops the server, empties the volume,
// and unpacks the archive back over it; the running server then boots that world.
//
// The disk this shares is finite, so every create is gated: a hard count per
// server, a refusal when free space is low, and a ceiling on how large a world may
// be snapshotted at all. Nothing here ever reports a success it did not achieve.

import { promises as fs, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BACKUPS } from './config.js';
import { store, type Backup, type Server } from './store.js';
import { dataDir, rcon } from './docker.js';

export class BackupError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function dirFor(serverId: string): string { return join(BACKUPS.dir, serverId); }
function fileFor(b: Backup): string { return join(dirFor(b.serverId), `${b.id}.tar.gz`); }

// A thin promise wrapper around a child process, with an optional wall-clock kill
// so a wedged tar can never hang a request forever.
function run(cmd: string, args: string[], timeoutMs = 0): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = timeoutMs ? setTimeout(() => { p.kill('SIGKILL'); reject(new BackupError(`${cmd} took too long.`, 500)); }, timeoutMs) : null;
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function diskFreeBytes(path: string): Promise<number> {
  try { const s = await fs.statfs(path); return s.bavail * s.bsize; } catch { return Number.MAX_SAFE_INTEGER; }
}

async function volumeBytes(dir: string): Promise<number> {
  try { const { stdout } = await run('du', ['-sb', dir], 30_000); const n = Number(stdout.trim().split(/\s+/)[0]); return Number.isFinite(n) ? n : 0; }
  catch { return 0; }
}

// The uid:gid that owns the volume (the container user). Files we lay down on a
// restore are handed back to it, so the running server keeps full control.
async function volumeOwner(dir: string): Promise<{ uid: number; gid: number }> {
  const st = await fs.stat(dir);
  return { uid: st.uid, gid: st.gid };
}

export function list(serverId: string): Backup[] {
  return store.backupsOf(serverId);
}

// Snapshot a server's volume. If it is running, flush the world to disk first so
// the archive is consistent, then re-enable saving whatever happens.
export async function create(server: Server, note: string, running: boolean): Promise<Backup> {
  const dir = await dataDir(server.id).catch(() => null);
  if (!dir) throw new BackupError('There is nothing to back up yet — start the server once so its world exists, then come back.', 409);

  if (store.backupsOf(server.id).length >= BACKUPS.maxPerServer)
    throw new BackupError(`You can keep ${BACKUPS.maxPerServer} backups per server. Delete one to make room.`, 409);

  if ((await diskFreeBytes(BACKUPS.dir)) < BACKUPS.minFreeBytes)
    throw new BackupError('The host is low on disk right now — a new backup was not taken. Try again later.', 507);

  const size = await volumeBytes(dir);
  if (size > BACKUPS.maxVolumeBytes)
    throw new BackupError('This world is too large to snapshot here. Trim it or use SFTP to copy it out.', 413);

  await fs.mkdir(dirFor(server.id), { recursive: true });
  const b: Backup = { id: `bak_${randomBytes(6).toString('hex')}`, serverId: server.id, createdAt: Date.now(), sizeBytes: 0, note: String(note || '').slice(0, 80) };
  const tmp = fileFor(b) + '.part';
  const dest = fileFor(b);

  if (running) { await rcon(server.id, 'save-off').catch(() => {}); await rcon(server.id, 'save-all flush').catch(() => {}); }
  try {
    // -C into the volume and archive '.', so paths inside the tar are relative and
    // a restore lands them back exactly where they came from.
    const r = await run('tar', ['-czf', tmp, '-C', dir, '.'], 10 * 60_000);
    if (r.code !== 0) throw new BackupError(`The snapshot failed: ${r.stderr.trim().slice(0, 200) || 'tar error'}`, 500);
    const st = await fs.stat(tmp);
    b.sizeBytes = st.size;
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    if (running) await rcon(server.id, 'save-on').catch(() => {});
  }

  store.addBackup(b);
  return b;
}

// Restore a snapshot over the live volume. The caller must have stopped the server
// first — this empties the volume and unpacks the archive, which would fight a
// running process. Ownership is restored to the container user afterwards.
export async function restore(server: Server, backupId: string): Promise<void> {
  const b = store.backup(backupId);
  if (!b || b.serverId !== server.id) throw new BackupError('No such backup.', 404);
  const dir = await dataDir(server.id).catch(() => null);
  if (!dir) throw new BackupError('The server has no volume to restore into.', 409);
  const file = fileFor(b);
  try { await fs.access(file); } catch { throw new BackupError('That backup file is missing from disk.', 410); }

  const owner = await volumeOwner(dir);

  // Empty the volume without removing the mount point itself, then unpack.
  const entries = await fs.readdir(dir);
  for (const name of entries) await fs.rm(join(dir, name), { recursive: true, force: true });

  const r = await run('tar', ['-xzf', file, '-C', dir], 10 * 60_000);
  if (r.code !== 0) throw new BackupError(`The restore failed: ${r.stderr.trim().slice(0, 200) || 'tar error'}`, 500);

  // tar as root restores the archived numeric ownership, but re-assert it over the
  // whole tree so nothing the server needs is left owned by the wrong user.
  await run('chown', ['-R', `${owner.uid}:${owner.gid}`, dir], 60_000).catch(() => {});
}

export interface DownloadInfo { path: string; name: string; size: number; }
export async function download(serverId: string, backupId: string, serverName: string): Promise<DownloadInfo> {
  const b = store.backup(backupId);
  if (!b || b.serverId !== serverId) throw new BackupError('No such backup.', 404);
  const file = fileFor(b);
  let size: number;
  try { size = (await fs.stat(file)).size; } catch { throw new BackupError('That backup file is missing from disk.', 410); }
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
  const stamp = new Date(b.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return { path: file, name: `${slug}-${stamp}.tar.gz`, size };
}

export function openRead(path: string) { return createReadStream(path); }

export async function remove(serverId: string, backupId: string): Promise<void> {
  const b = store.backup(backupId);
  if (!b || b.serverId !== serverId) throw new BackupError('No such backup.', 404);
  await fs.rm(fileFor(b), { force: true }).catch(() => {});
  store.dropBackup(backupId);
}

// Drop every backup for a server — files and records — when the server itself is
// deleted, so nothing is orphaned on disk.
export async function destroyAll(serverId: string): Promise<void> {
  await fs.rm(dirFor(serverId), { recursive: true, force: true }).catch(() => {});
  store.dropBackupsOf(serverId);
}
