// The subdomain router. One TCP listener on :25565 that speaks just enough of the
// Minecraft protocol to read the hostname a player typed — which the client puts
// in the very first packet (the handshake) — and then hands the connection to the
// right server's container on the loopback. From the player's side it is ordinary
// Minecraft: they join `example.invalid` and land on their server.
//
// It never decrypts or rewrites the stream. For a running server it peeks the
// handshake, then splices the two sockets together untouched. For a sleeping or
// unknown one it answers the server-list ping itself (so the MOTD explains what is
// going on) and, on a real join attempt, wakes the server and asks the player to
// reconnect.

import net from 'node:net';
import { MCROUTER as CFG, FREE_PLAN } from './config.js';
import { store, type Server } from './store.js';
import * as mc from './docker.js';

export interface RouterHooks { wake?: (server: Server) => void; }

// ---- VarInt + string, the two primitives the handshake is built from ----
function readVarInt(buf: Buffer, start: number): { value: number; size: number } | null {
  let value = 0, size = 0, byte = 0;
  do {
    if (start + size >= buf.length) return null; // need more bytes
    byte = buf[start + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) throw new Error('VarInt too big');
  } while (byte & 0x80);
  return { value: value >>> 0, size };
}
function varInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
function mcString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(b.length), b]);
}

interface Handshake { protocol: number; address: string; port: number; nextState: number; consumed: number; }
// Parse the handshake if the whole packet has arrived; null means "need more".
function parseHandshake(buf: Buffer): Handshake | null {
  const lenR = readVarInt(buf, 0);
  if (!lenR) return null;
  if (lenR.value > 4096) throw new Error('handshake too large');
  const total = lenR.size + lenR.value;
  if (buf.length < total) return null;
  let off = lenR.size;
  const idR = readVarInt(buf, off); if (!idR) return null; off += idR.size;
  if (idR.value !== 0x00) throw new Error('not a handshake');
  const protoR = readVarInt(buf, off); if (!protoR) return null; off += protoR.size;
  const addrLenR = readVarInt(buf, off); if (!addrLenR) return null; off += addrLenR.size;
  if (off + addrLenR.value + 2 > buf.length) return null;
  const address = buf.toString('utf8', off, off + addrLenR.value); off += addrLenR.value;
  const port = buf.readUInt16BE(off); off += 2;
  const nextR = readVarInt(buf, off); if (!nextR) return null;
  return { protocol: protoR.value, address, port, nextState: nextR.value, consumed: total };
}

// The hostname the client actually typed, cleaned of the odds and ends some
// clients tack on: Forge appends "\0FML\0", and some add a trailing dot.
function cleanHost(address: string): string {
  return address.split('\0')[0].toLowerCase().replace(/\.$/, '');
}

// Pull the subdomain label out of a `<label>.<domain>` host; null for anything
// that isn't one of our subdomains (a bare IP, the apex, or a custom domain).
function labelFrom(host: string): string | null {
  const suffix = '.' + CFG.domain;
  if (host.endsWith(suffix)) return host.slice(0, -suffix.length) || null;
  return null;
}

// Login-state disconnect carrying a chat message the player will see.
function kick(client: net.Socket, message: string): void {
  try {
    const payload = Buffer.concat([varInt(0x00), mcString(JSON.stringify({ text: message }))]);
    client.write(Buffer.concat([varInt(payload.length), payload]));
  } catch { /* socket already gone */ }
  client.end();
}

// Answer a server-list ping ourselves (used when the target is asleep/unknown),
// including echoing the ping so the client shows a latency number. `seed` carries
// any bytes that were pipelined right after the handshake.
function statusReply(client: net.Socket, motdJson: string, seed: Buffer): void {
  let buf = seed;
  const pump = () => {
    for (;;) {
      const lenR = readVarInt(buf, 0);
      if (!lenR || buf.length < lenR.size + lenR.value) return;
      const packet = buf.subarray(lenR.size, lenR.size + lenR.value);
      buf = buf.subarray(lenR.size + lenR.value);
      const idR = readVarInt(packet, 0); if (!idR) continue;
      if (idR.value === 0x00) {
        const p = Buffer.concat([varInt(0x00), mcString(motdJson)]);
        client.write(Buffer.concat([varInt(p.length), p]));
      } else if (idR.value === 0x01) {
        const echo = packet.subarray(idR.size); // 8-byte token
        const p = Buffer.concat([varInt(0x01), echo]);
        client.write(Buffer.concat([varInt(p.length), p]));
        client.end();
      }
    }
  };
  client.on('data', (d) => { buf = Buffer.concat([buf, d]); try { pump(); } catch { client.destroy(); } });
  try { pump(); } catch { client.destroy(); }
}

function offlineMotd(protocol: number, srv: Server | null): string {
  return JSON.stringify({
    version: { name: srv ? 'Asleep' : 'Endhost', protocol },
    players: { max: srv ? FREE_PLAN.maxPlayers : 0, online: 0, sample: [] },
    description: { text: srv ? `§6${srv.name}§r §7— asleep. Join to wake it, or press Start in the panel.` : `§cNo server answers to that address.` },
  });
}

async function route(client: net.Socket, buffered: Buffer, hs: Handshake, hooks: RouterHooks): Promise<void> {
  // Match either one of our own subdomains or a custom domain the owner pointed
  // here by DNS — both arrive as the host in the handshake, so the lookup is the
  // same connection either way.
  const host = cleanHost(hs.address);
  const label = labelFrom(host);
  const srv = (label ? store.serverBySubdomain(label) : null) ?? store.serverByCustomDomain(host);
  const rest = buffered.subarray(hs.consumed);

  if (!srv) {
    if (hs.nextState === 1) return statusReply(client, offlineMotd(hs.protocol, null), rest);
    return kick(client, `§cNo Endhost server answers to §f${hs.address}§c.`);
  }

  let running = false;
  try { running = (await mc.state(srv.id)).running; } catch { /* treat as down */ }

  if (!running) {
    if (hs.nextState === 1) return statusReply(client, offlineMotd(hs.protocol, srv), rest);
    hooks.wake?.(srv); // a real join attempt wakes it
    return kick(client, `§e${srv.name} is waking up…\n§7Reconnect in about 30 seconds.`);
  }

  // Running: splice straight through, replaying the bytes we peeked.
  const upstream = net.connect(srv.port, '127.0.0.1');
  upstream.setNoDelay(true);
  upstream.on('connect', () => {
    upstream.write(buffered);
    client.pipe(upstream);
    upstream.pipe(client);
    store.touchServer(srv.id, { lastActive: Date.now() });
  });
  upstream.on('error', () => { if (hs.nextState === 2) kick(client, `§cCould not reach ${srv.name}.`); else client.destroy(); upstream.destroy(); });
  upstream.on('close', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
}

// The one live listener, kept at module scope so the operator can close it at
// runtime (maintenance mode) to hand port 25580 back, then open it again — without
// bouncing the whole panel process.
let listener: net.Server | null = null;

export function routerListening(): boolean {
  return !!listener && listener.listening;
}

export function startRouter(hooks: RouterHooks = {}): void {
  if (!CFG.enabled) { console.log('[endhost] MC router disabled'); return; }
  if (listener) return; // already up — idempotent

  const server = net.createServer((client) => {
    client.setNoDelay(true);
    let chunks: Buffer[] = [];
    let total = 0;
    let handled = false;
    const onData = (d: Buffer) => {
      total += d.length;
      if (total > 8192) { client.destroy(); return; } // a handshake is tiny; anything huge is junk
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      let hs: Handshake | null;
      try { hs = parseHandshake(buf); } catch { client.destroy(); return; }
      if (!hs) return; // wait for the rest of the packet
      handled = true;
      client.removeListener('data', onData);
      void route(client, buf, hs, hooks);
    };
    client.on('data', onData);
    client.on('error', () => {});
    client.setTimeout(15000, () => { if (!handled) client.destroy(); });
  });

  server.on('error', (e: any) => console.error('[endhost] MC router error:', e?.message || e));
  server.on('close', () => { if (listener === server) listener = null; });
  server.listen(CFG.port, CFG.bindHost, () => {
    console.log(`[endhost] MC router on ${CFG.bindHost}:${CFG.port} → *.${CFG.domain}`);
  });
  listener = server;
}

// Close the listener so nothing holds port 25580. Existing spliced connections are
// left to end on their own; only the accept socket is released.
export function stopRouter(): Promise<void> {
  const server = listener;
  listener = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => { console.log(`[endhost] MC router on :${CFG.port} stopped`); resolve(); });
  });
}
