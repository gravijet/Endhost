// The web file manager's real filesystem layer.
//
// A server's world, configs, plugins and mods all live in the container's /data
// volume. This module resolves that volume's path on the host and does ordinary
// fs work on it — list, read, edit, upload, download, rename, delete — with every
// client-supplied path confined to the volume root. A request can name a file
// inside the server; it can never climb out to the rest of the machine.
//
// Anything the panel creates is chowned to whoever owns the volume (the container
// user), so the running server keeps full control of what we write for it.

import { promises as fs, createReadStream, createWriteStream, type Stats } from 'node:fs';
import { join, normalize, sep, dirname, basename } from 'node:path';
import type { Request } from 'express';
import { FILES } from './config.js';
import { dataDir } from './docker.js';

export interface Entry { name: string; type: 'dir' | 'file'; size: number; mtime: number; }

// Files the in-browser editor is willing to open. Everything else is binary and
// download-only. An extensionless file (eula, whitelist) counts as text.
const TEXT_EXT = new Set([
  '', '.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.toml',
  '.conf', '.cfg', '.ini', '.log', '.md', '.mcmeta', '.csv', '.xml', '.html',
  '.css', '.js', '.sh', '.lang', '.snbt', '.mcfunction', '.list', '.env',
]);

export class FileError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

// The /data volume for a server, or a clean 409 if it does not exist yet (the
// world is created on the container's first boot).
export async function rootFor(id: string): Promise<string> {
  const dir = await dataDir(id).catch(() => null);
  if (!dir) throw new FileError('The files appear once the server has started at least once. Start it, then come back.', 409);
  return dir;
}

// Confine a client path to the volume root. Prefixing a leading slash makes
// normalize() collapse any ".." before it can climb above the (virtual) root;
// the join then lands inside `root`, and the prefix check is the belt over that.
export function resolveIn(root: string, rel: string): string {
  const cleaned = normalize('/' + String(rel || '')).replace(/^[/\\]+/, '');
  const full = normalize(join(root, cleaned));
  const rootN = normalize(root);
  if (full !== rootN && !full.startsWith(rootN + sep)) {
    throw new FileError('That path is outside the server.', 400);
  }
  return full;
}

// A symlink inside the tree could still point out of the volume. realpath the
// deepest part that exists (the leaf may be about to be created) and re-check.
export async function assertReal(root: string, full: string): Promise<void> {
  let probe = full;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const rootReal = await fs.realpath(root);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new FileError('That path is outside the server.', 400);
      }
      return;
    } catch (e: any) {
      if (e instanceof FileError) throw e;
      if (e.code === 'ENOENT') {
        const parent = dirname(probe);
        if (parent === probe) return;
        probe = parent;
        continue;
      }
      return; // any other error surfaces from the real operation
    }
  }
}

export function isTextName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  return TEXT_EXT.has(ext);
}

// Hand a path we just created to whoever owns the volume (the container user),
// so the running server keeps full control of it. Best effort — a failure here
// never fails the operation the user asked for. Exported for the SFTP gateway,
// which writes into the very same volume and wants the same ownership rule.
export async function chownLikeRoot(root: string, target: string): Promise<void> {
  try { const st = await fs.stat(root); await fs.chown(target, st.uid, st.gid); } catch { /* best effort */ }
}
const matchOwner = chownLikeRoot;

function cleanRel(rel: string): string {
  return normalize('/' + String(rel || '')).replace(/\/+$/, '') || '/';
}

export async function list(root: string, rel: string): Promise<{ path: string; entries: Entry[] }> {
  const dir = resolveIn(root, rel);
  await assertReal(root, dir);
  let st: Stats;
  try { st = await fs.stat(dir); } catch { throw new FileError('No such folder.', 404); }
  if (!st.isDirectory()) throw new FileError('That is a file, not a folder.', 400);
  const names = await fs.readdir(dir);
  const entries: Entry[] = [];
  for (const name of names) {
    try {
      const s = await fs.lstat(join(dir, name));
      const isDir = s.isDirectory();
      if (!isDir && !s.isFile()) continue; // skip sockets, devices, dangling links
      entries.push({ name, type: isDir ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs });
    } catch { /* skip an entry we cannot stat */ }
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  return { path: cleanRel(rel), entries };
}

export async function readText(root: string, rel: string): Promise<{ path: string; content: string }> {
  const full = resolveIn(root, rel);
  await assertReal(root, full);
  let st: Stats;
  try { st = await fs.stat(full); } catch { throw new FileError('No such file.', 404); }
  if (!st.isFile()) throw new FileError('That is a folder, not a file.', 400);
  if (st.size > FILES.maxEditBytes) throw new FileError('This file is too large to edit here — download it instead.', 413);
  const buf = await fs.readFile(full);
  if (buf.includes(0)) throw new FileError('This looks like a binary file — download it instead.', 415);
  return { path: cleanRel(rel), content: buf.toString('utf8') };
}

export async function writeText(root: string, rel: string, content: string): Promise<void> {
  const full = resolveIn(root, rel);
  await assertReal(root, dirname(full));
  if (Buffer.byteLength(content, 'utf8') > FILES.maxEditBytes) throw new FileError('That is too large to save here.', 413);
  let st: Stats | null = null;
  try { st = await fs.stat(full); } catch { /* new file */ }
  if (st && st.isDirectory()) throw new FileError('That is a folder.', 400);
  await fs.mkdir(dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  await matchOwner(root, full);
}

export async function mkdir(root: string, rel: string): Promise<void> {
  const full = resolveIn(root, rel);
  if (normalize(full) === normalize(root)) throw new FileError('Give the folder a name.', 400);
  await assertReal(root, dirname(full));
  await fs.mkdir(full, { recursive: true });
  await matchOwner(root, full);
}

export async function remove(root: string, rel: string): Promise<void> {
  const full = resolveIn(root, rel);
  if (normalize(full) === normalize(root)) throw new FileError('You cannot delete the server root.', 400);
  await assertReal(root, full);
  await fs.rm(full, { recursive: true, force: true });
}

export async function rename(root: string, fromRel: string, toRel: string): Promise<void> {
  const from = resolveIn(root, fromRel);
  const to = resolveIn(root, toRel);
  if (normalize(from) === normalize(root)) throw new FileError('You cannot move the server root.', 400);
  await assertReal(root, from);
  await assertReal(root, dirname(to));
  try { await fs.stat(from); } catch { throw new FileError('No such file or folder.', 404); }
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.rename(from, to);
}

export interface DownloadInfo { full: string; name: string; size: number; }
export async function statFile(root: string, rel: string): Promise<DownloadInfo> {
  const full = resolveIn(root, rel);
  await assertReal(root, full);
  let st: Stats;
  try { st = await fs.stat(full); } catch { throw new FileError('No such file.', 404); }
  if (!st.isFile()) throw new FileError('That is a folder, not a file.', 400);
  return { full, name: basename(full), size: st.size };
}

export function openRead(full: string) { return createReadStream(full); }

// Stream an upload straight to a temp file next to its target, enforcing the size
// cap as bytes arrive so nothing ever buffers in memory or overruns the disk. On
// success the temp file is atomically renamed into place.
export async function saveUpload(root: string, rel: string, req: Request): Promise<{ size: number }> {
  const full = resolveIn(root, rel);
  if (normalize(full) === normalize(root)) throw new FileError('Give the file a name.', 400);
  await assertReal(root, dirname(full));
  await fs.mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.part-${process.pid}-${Math.round(process.hrtime()[1])}`;
  const out = createWriteStream(tmp);
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > FILES.maxUploadBytes) {
          req.unpipe(out);
          reject(new FileError('That file is over the upload limit.', 413));
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      req.pipe(out);
    });
  } catch (e) {
    out.destroy();
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await fs.rename(tmp, full);
  await matchOwner(root, full);
  return { size };
}
