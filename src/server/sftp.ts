// Per-server SFTP, the professional way: one gateway process (no sshd inside any
// container) that speaks the panel's own accounts. A client connects with the
// server's id as the username and the account's SFTP password; on success the
// whole session is jailed to that server's /data volume — the same real files
// the web manager edits. Every path is confined exactly as it is there, and
// anything the client creates is handed to the container user so the running
// server keeps control of it.
//
// This is intentionally its own TCP listener (default :2222), separate from the
// web service, and never touches the host's real sshd on :22.

import { Server as SSHServer, utils, type Connection } from 'ssh2';
import { promises as fsp, type Stats } from 'node:fs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, sep, relative } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { SFTP as CFG } from './config.js';
import { store } from './store.js';
import { verifyPassword } from './auth.js';
import { rootFor, resolveIn, assertReal, chownLikeRoot, FileError } from './files.js';

const { OPEN_MODE, STATUS_CODE, flagsToString } = utils.sftp;

// ---------------------------------------------------------------- host key
// Generated once and persisted, so a client's known-hosts pin stays valid across
// restarts. RSA-2048 PEM is understood by every SFTP client and by ssh2 itself.
function loadHostKey(): string {
  const p = CFG.hostKeyPath;
  if (existsSync(p)) return readFileSync(p, 'utf8');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, privateKey);
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
  console.log(`[endhost] generated SFTP host key at ${p}`);
  return privateKey;
}

// -------------------------------------------------------- auth brute-force gate
// A handful of tries per IP per minute — enough for a fat-fingered password,
// far too few to grind one.
const attempts = new Map<string, { n: number; until: number }>();
function tooMany(ip: string): boolean {
  const e = attempts.get(ip);
  return !!(e && e.until > Date.now() && e.n >= 8);
}
function noteFail(ip: string): void {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || e.until < now) attempts.set(ip, { n: 1, until: now + 60_000 });
  else e.n++;
}

// ------------------------------------------------------------- attr helpers
interface Attrs { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number; }
function toAttrs(st: Stats): Attrs {
  return {
    mode: st.mode, uid: st.uid, gid: st.gid, size: st.size,
    atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function permBits(mode: number): string {
  const g = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return g((mode >> 6) & 7) + g((mode >> 3) & 7) + g(mode & 7);
}
// An ls -l style line for clients that render it (most use attrs instead).
function longname(name: string, st: Stats): string {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  const d = new Date(st.mtimeMs);
  const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${type}${permBits(st.mode)} 1 owner group ${String(st.size).padStart(8, ' ')} ${when} ${name}`;
}

// The canonical virtual path a client should see for a resolved real path: the
// jail root is "/". Used by REALPATH so clients can build absolute paths.
function virtualOf(root: string, full: string): string {
  const rel = relative(root, full).split(sep).join('/');
  return rel ? '/' + rel : '/';
}

// Map a thrown error to the closest SFTP status code.
function codeFor(e: any): number {
  if (e?.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  if (e instanceof FileError) return STATUS_CODE.PERMISSION_DENIED; // jail violation
  return STATUS_CODE.FAILURE;
}

// --------------------------------------------------------------- one session
// Wire an accepted SFTP channel to real fs work, jailed to `root`.
function wireSftp(sftp: any, root: string): void {
  let counter = 0;
  const filesOpen = new Map<number, { fh: fsp.FileHandle; full: string; write: boolean }>();
  const dirsOpen = new Map<number, { full: string; done: boolean }>();
  const newHandle = (): { n: number; buf: Buffer } => {
    const n = counter++;
    const buf = Buffer.alloc(4); buf.writeUInt32BE(n, 0);
    return { n, buf };
  };
  const idOf = (h: Buffer): number => h.readUInt32BE(0);
  const fail = (reqid: number, e: any): void => { sftp.status(reqid, codeFor(e)); };

  sftp.on('REALPATH', async (reqid: number, given: string) => {
    try {
      const full = resolveIn(root, given);
      const vpath = virtualOf(root, full);
      let attrs: Attrs;
      try { attrs = toAttrs(await fsp.stat(full)); }
      catch { attrs = { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }; }
      sftp.name(reqid, [{ filename: vpath, longname: vpath, attrs }]);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on('OPEN', async (reqid: number, filename: string, flags: number) => {
    try {
      const full = resolveIn(root, filename);
      await assertReal(root, full);
      const mode = flagsToString(flags);
      if (!mode) return sftp.status(reqid, STATUS_CODE.FAILURE);
      const fh = await fsp.open(full, mode);
      const write = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
      const { buf } = trackFile(fh, full, write);
      sftp.handle(reqid, buf);
    } catch (e) { fail(reqid, e); }
  });

  function trackFile(fh: fsp.FileHandle, full: string, write: boolean): { buf: Buffer } {
    const { n, buf } = newHandle();
    filesOpen.set(n, { fh, full, write });
    return { buf };
  }

  sftp.on('READ', async (reqid: number, handle: Buffer, offset: number, length: number) => {
    const e = filesOpen.get(idOf(handle));
    if (!e) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await e.fh.read(buf, 0, length, offset);
      if (bytesRead <= 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, bytesRead));
    } catch (err) { fail(reqid, err); }
  });

  sftp.on('WRITE', async (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
    const e = filesOpen.get(idOf(handle));
    if (!e) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      await e.fh.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) { fail(reqid, err); }
  });

  sftp.on('FSTAT', async (reqid: number, handle: Buffer) => {
    const e = filesOpen.get(idOf(handle));
    if (!e) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try { sftp.attrs(reqid, toAttrs(await e.fh.stat())); }
    catch (err) { fail(reqid, err); }
  });

  sftp.on('FSETSTAT', async (reqid: number, handle: Buffer, attrs: any) => {
    const e = filesOpen.get(idOf(handle));
    if (!e) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try { await applyAttrs(e.full, attrs); sftp.status(reqid, STATUS_CODE.OK); }
    catch (err) { fail(reqid, err); }
  });

  sftp.on('CLOSE', async (reqid: number, handle: Buffer) => {
    const n = idOf(handle);
    const f = filesOpen.get(n);
    if (f) {
      filesOpen.delete(n);
      try { await f.fh.close(); } catch { /* already gone */ }
      if (f.write) await chownLikeRoot(root, f.full).catch(() => {});
      return sftp.status(reqid, STATUS_CODE.OK);
    }
    dirsOpen.delete(n);
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('OPENDIR', async (reqid: number, given: string) => {
    try {
      const full = resolveIn(root, given);
      await assertReal(root, full);
      const st = await fsp.stat(full);
      if (!st.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
      const { n, buf } = newHandle();
      dirsOpen.set(n, { full, done: false });
      sftp.handle(reqid, buf);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on('READDIR', async (reqid: number, handle: Buffer) => {
    const d = dirsOpen.get(idOf(handle));
    if (!d) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (d.done) return sftp.status(reqid, STATUS_CODE.EOF);
    try {
      const names = await fsp.readdir(d.full);
      const out: Array<{ filename: string; longname: string; attrs: Attrs }> = [];
      for (const name of names) {
        try {
          const st = await fsp.lstat(join(d.full, name));
          if (!st.isDirectory() && !st.isFile()) continue;
          out.push({ filename: name, longname: longname(name, st), attrs: toAttrs(st) });
        } catch { /* skip an entry we cannot stat */ }
      }
      d.done = true;
      sftp.name(reqid, out);
    } catch (e) { fail(reqid, e); }
  });

  const doStat = (useLstat: boolean) => async (reqid: number, given: string) => {
    try {
      const full = resolveIn(root, given);
      await assertReal(root, full);
      const st = useLstat ? await fsp.lstat(full) : await fsp.stat(full);
      sftp.attrs(reqid, toAttrs(st));
    } catch (e) { fail(reqid, e); }
  };
  sftp.on('LSTAT', doStat(true));
  sftp.on('STAT', doStat(false));

  sftp.on('SETSTAT', async (reqid: number, given: string, attrs: any) => {
    try {
      const full = resolveIn(root, given);
      await assertReal(root, full);
      await applyAttrs(full, attrs);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (e) { fail(reqid, e); }
  });

  // Preserve what a client legitimately sets on its own files (times, mode), but
  // never let it change ownership — that stays with the container user.
  async function applyAttrs(full: string, attrs: any): Promise<void> {
    if (!attrs) return;
    if (typeof attrs.mode === 'number') { try { await fsp.chmod(full, attrs.mode & 0o777); } catch { /* best effort */ } }
    if (typeof attrs.atime === 'number' && typeof attrs.mtime === 'number') {
      try { await fsp.utimes(full, attrs.atime, attrs.mtime); } catch { /* best effort */ }
    }
  }

  sftp.on('MKDIR', async (reqid: number, given: string, _attrs: any) => {
    try {
      const full = resolveIn(root, given);
      await assertReal(root, dirname(full));
      await fsp.mkdir(full);
      await chownLikeRoot(root, full).catch(() => {});
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on('RMDIR', async (reqid: number, given: string) => {
    try {
      const full = resolveIn(root, given);
      if (full === root) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
      await assertReal(root, full);
      await fsp.rmdir(full);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on('REMOVE', async (reqid: number, given: string) => {
    try {
      const full = resolveIn(root, given);
      await assertReal(root, full);
      await fsp.unlink(full);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (e) { fail(reqid, e); }
  });

  sftp.on('RENAME', async (reqid: number, oldPath: string, newPath: string) => {
    try {
      const from = resolveIn(root, oldPath);
      const to = resolveIn(root, newPath);
      if (from === root) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
      await assertReal(root, from);
      await assertReal(root, dirname(to));
      await fsp.rename(from, to);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (e) { fail(reqid, e); }
  });

  // We never present symlinks as followable and never let one be created — that
  // would be the one way to point a path out of the jail.
  sftp.on('READLINK', (reqid: number) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
  sftp.on('SYMLINK', (reqid: number) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED));

  const shut = async (): Promise<void> => {
    for (const f of filesOpen.values()) { try { await f.fh.close(); } catch { /* ignore */ } }
    filesOpen.clear(); dirsOpen.clear();
  };
  sftp.on('end', shut);
  sftp.on('close', shut);
}

// ------------------------------------------------------------------- server
export function startSftp(): void {
  if (!CFG.enabled) { console.log('[endhost] SFTP gateway disabled'); return; }
  const hostKey = loadHostKey();

  const sshd = new SSHServer({ hostKeys: [hostKey] }, (client: Connection, info: any) => {
    const ip: string = info?.ip || 'unknown';
    let jail: string | null = null;

    client.on('authentication', async (ctx) => {
      try {
        if (ctx.method !== 'password') return ctx.reject(['password']);
        if (tooMany(ip)) return ctx.reject();
        const srv = store.server(String(ctx.username || ''));  // username == server id
        const password = (ctx as any).password as string;
        if (!srv) { noteFail(ip); return ctx.reject(); }
        const user = store.userById(srv.owner);
        if (!user?.sftpHash || !user.sftpSalt || !verifyPassword(password, user.sftpSalt, user.sftpHash)) {
          noteFail(ip); return ctx.reject();
        }
        const root = await rootFor(srv.id).catch(() => null);
        if (!root) { noteFail(ip); return ctx.reject(); } // no volume yet — nothing to serve
        jail = root;
        attempts.delete(ip);
        ctx.accept();
      } catch { ctx.reject(); }
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acc: any) => { wireSftp(acc(), jail!); });
        // SFTP only: refuse interactive shells and command execution.
        session.on('exec', (_a: any, rej: any) => rej && rej());
        session.on('shell', (_a: any, rej: any) => rej && rej());
      });
    });

    client.on('error', () => { /* client dropped — nothing to do */ });
  });

  sshd.on('error', (e: any) => console.error('[endhost] SFTP server error:', e?.message || e));
  sshd.listen(CFG.port, CFG.bindHost, () => {
    console.log(`[endhost] SFTP gateway on ${CFG.bindHost}:${CFG.port} (advertised as ${CFG.publicHost})`);
  });
}
