// The plugin & mod marketplace, backed by Modrinth. Search returns real projects
// filtered to what this server can actually load; install downloads the primary
// jar Modrinth names for a compatible build, checks it against the sha512 Modrinth
// published, and drops it into the server's own plugins/ or mods/ folder (chowned
// to the container user, like everything else we write). A restart loads it.
//
// The only things ever fetched are Modrinth's JSON and a download URL on its own
// CDN — that host is checked before a single byte is read.

import { promises as fsp, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { MODRINTH } from './config.js';
import { resolveIn, assertReal, chownLikeRoot } from './files.js';

export class ModrinthError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

// How each server flavour maps onto Modrinth: which loader categories to search,
// which loaders a build must declare to be compatible, and where its jars live.
export interface Target { categories: string[]; loaders: string[]; dir: 'plugins' | 'mods'; kind: 'plugins' | 'mods'; }
export function targetFor(software: string): Target | null {
  switch (software) {
    case 'paper':  return { categories: ['paper', 'spigot', 'bukkit', 'folia'], loaders: ['paper', 'spigot', 'bukkit', 'folia'], dir: 'plugins', kind: 'plugins' };
    case 'purpur': return { categories: ['purpur', 'paper', 'spigot', 'bukkit', 'folia'], loaders: ['purpur', 'paper', 'spigot', 'bukkit', 'folia'], dir: 'plugins', kind: 'plugins' };
    case 'fabric': return { categories: ['fabric'], loaders: ['fabric'], dir: 'mods', kind: 'mods' };
    case 'forge':  return { categories: ['forge'], loaders: ['forge'], dir: 'mods', kind: 'mods' };
    default:       return null; // vanilla loads neither
  }
}

async function getJSON(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': MODRINTH.userAgent, Accept: 'application/json' } });
  } catch { throw new ModrinthError('Could not reach Modrinth. Try again in a moment.', 502); }
  if (res.status === 404) throw new ModrinthError('Not found on Modrinth.', 404);
  if (res.status === 429) throw new ModrinthError('Modrinth is rate-limiting us — try again shortly.', 429);
  if (!res.ok) throw new ModrinthError(`Modrinth is unavailable right now (${res.status}).`, 502);
  return res.json();
}

export interface Hit {
  projectId: string; slug: string; title: string; description: string;
  downloads: number; iconUrl: string | null; author: string; categories: string[];
}
export async function search(opts: { software: string; gameVersion?: string; query?: string; offset?: number; limit?: number }): Promise<Hit[]> {
  const t = targetFor(opts.software);
  if (!t) return [];
  const facets: string[][] = [t.categories.map((c) => `categories:${c}`)];
  if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`]);
  const url = new URL(MODRINTH.api + '/search');
  url.searchParams.set('query', opts.query || '');
  url.searchParams.set('limit', String(Math.min(opts.limit ?? MODRINTH.searchLimit, 50)));
  url.searchParams.set('offset', String(Math.max(0, opts.offset ?? 0)));
  url.searchParams.set('index', opts.query ? 'relevance' : 'downloads');
  url.searchParams.set('facets', JSON.stringify(facets));
  const data = await getJSON(url.toString());
  const loaderSet = new Set(t.loaders);
  return (data.hits || []).map((h: any) => ({
    projectId: h.project_id, slug: h.slug, title: h.title,
    description: h.description || '', downloads: h.downloads || 0,
    iconUrl: h.icon_url || null, author: h.author || '',
    categories: (h.display_categories || h.categories || []).filter((c: string) => !loaderSet.has(c)).slice(0, 4),
  }));
}

export interface FileRef { url: string; filename: string; size: number; sha512: string | null; }
export interface VersionInfo { versionId: string; name: string; versionNumber: string; datePublished: string; file: FileRef; }
export async function versions(opts: { software: string; gameVersion?: string; projectId: string }): Promise<VersionInfo[]> {
  const t = targetFor(opts.software);
  if (!t) return [];
  if (!opts.projectId) throw new ModrinthError('No project given.', 400);
  const url = new URL(`${MODRINTH.api}/project/${encodeURIComponent(opts.projectId)}/version`);
  url.searchParams.set('loaders', JSON.stringify(t.loaders));
  if (opts.gameVersion) url.searchParams.set('game_versions', JSON.stringify([opts.gameVersion]));
  const arr = await getJSON(url.toString());
  const out: VersionInfo[] = [];
  for (const v of arr || []) {
    const f = (v.files || []).find((x: any) => x.primary) || (v.files || [])[0];
    if (!f) continue;
    out.push({
      versionId: v.id, name: v.name, versionNumber: v.version_number, datePublished: v.date_published,
      file: { url: f.url, filename: f.filename, size: f.size || 0, sha512: f.hashes?.sha512 ?? null },
    });
  }
  return out;
}

// Download the chosen build into the server's plugins/ or mods/ folder. Streams to
// a temp file with a hard size cap, verifies the sha512, then atomically renames.
export async function install(opts: { root: string; software: string; gameVersion?: string; projectId: string; versionId?: string }): Promise<{ filename: string; dir: string; title?: string }> {
  const t = targetFor(opts.software);
  if (!t) throw new ModrinthError('This server type runs neither plugins nor mods.', 400);
  const vers = await versions(opts);
  if (!vers.length) throw new ModrinthError(`No build for this server (${opts.software} ${opts.gameVersion ?? ''}).`, 404);
  const pick = opts.versionId ? vers.find((v) => v.versionId === opts.versionId) : vers[0];
  if (!pick) throw new ModrinthError('That version is not compatible with this server.', 404);

  const f = pick.file;
  // Only ever download from Modrinth's own CDN.
  let host = '';
  try { host = new URL(f.url).host.toLowerCase(); } catch { /* handled below */ }
  if (!/(^|\.)modrinth\.com$/.test(host)) throw new ModrinthError('Refusing a download from outside Modrinth.', 400);
  if (f.size && f.size > MODRINTH.maxFileBytes) throw new ModrinthError('That file is larger than the install limit.', 413);

  const filename = basename(f.filename).replace(/[/\\]/g, '_') || 'download.jar';
  const full = resolveIn(opts.root, `${t.dir}/${filename}`);
  await assertReal(opts.root, dirname(full));
  await fsp.mkdir(dirname(full), { recursive: true });
  await download(f.url, full, f.sha512);
  await chownLikeRoot(opts.root, full).catch(() => {});
  return { filename, dir: t.dir };
}

async function download(url: string, full: string, expectSha512: string | null): Promise<void> {
  let res: Response;
  try { res = await fetch(url, { headers: { 'User-Agent': MODRINTH.userAgent } }); }
  catch { throw new ModrinthError('The download could not be started.', 502); }
  if (!res.ok || !res.body) throw new ModrinthError(`The download failed (${res.status}).`, 502);

  const tmp = `${full}.part-${process.pid}-${Math.round(process.hrtime()[1])}`;
  const hash = createHash('sha512');
  const out = createWriteStream(tmp);
  let size = 0;
  try {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MODRINTH.maxFileBytes) throw new ModrinthError('That file is larger than the install limit.', 413);
      hash.update(value);
      if (!out.write(Buffer.from(value))) await once(out, 'drain');
    }
    await new Promise<void>((resolve, reject) => out.end((e: any) => (e ? reject(e) : resolve())));
    if (expectSha512 && hash.digest('hex') !== expectSha512) {
      throw new ModrinthError('The download failed its integrity check and was discarded.', 502);
    }
    await fsp.rename(tmp, full);
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
