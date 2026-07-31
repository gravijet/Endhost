import { wireClicks, sound } from './sound.js';
import { el, $, clear, toast } from './dom.js';
import { motdToHtml, fmtBytes, ago } from './mc.js';
import { api, ApiError, type Meta, type ServerDetail, type ServerSummary, type LiveState, type FileEntry, type DirListing, type SftpInfo, type ModHit, type Me, type CreditsInfo, type AdminUser, type AdminServer, type Tx, type Backup, type Roster, type PlayerAction, type WorldInfo, type GameRuleDef, type DomainInfo, type DomainCheck, type MetricsInfo, type SchedulesInfo, type Schedule, type ScheduleActionDef, type NetworkServer, type AdminNetworkServer, type ProxyAction, type MaintenanceInfo, type Rank, type RankAssignment, type RanksInfo } from './api.js';

wireClicks();

const app = $('#app')!;
let meta: Meta | null = null;
let me: Me | null = null;

// Every page tears down its own timers and sockets: navigating anywhere runs the
// registered disposers, so a poll loop or a live console never outlives its page.
let disposers: Array<() => void> = [];
function onDispose(fn: () => void): void { disposers.push(fn); }
function dispose(): void { const d = disposers; disposers = []; for (const fn of d) { try { fn(); } catch { /* ignore */ } } }

function fail(e: unknown): string { return e instanceof ApiError ? e.message : 'Network error — try again.'; }

// --------------------------------------------------------------- routing
// Every section is its own URL, so the browser's Back/Forward move between them
// and each page is a real, bookmarkable place — nothing is a hidden tab.
type ServerSection = 'overview' | 'console' | 'players' | 'world' | 'files' | 'plugins' | 'backups' | 'schedule' | 'network' | 'access' | 'settings';
const SERVER_SECTIONS: ServerSection[] = ['overview', 'console', 'players', 'world', 'files', 'plugins', 'backups', 'schedule', 'network', 'access', 'settings'];

type Route =
  | { kind: 'new' }
  | { kind: 'server'; id: string; section: ServerSection }
  | { kind: 'network' }
  | { kind: 'proxy'; section: ProxySection }
  | { kind: 'docs' }
  | { kind: 'billing' }
  | { kind: 'account' }
  | { kind: 'admin'; section: 'accounts' | 'servers' | 'ranks' };

type ProxySection = 'console' | 'files' | 'settings';
const PROXY_SECTIONS: ProxySection[] = ['console', 'files', 'settings'];

function parseHash(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) {
    const sec = (parts[2] as ServerSection) || 'overview';
    return { kind: 'server', id: parts[1], section: SERVER_SECTIONS.includes(sec) ? sec : 'overview' };
  }
  if (parts[0] === 'network') return { kind: 'network' };
  if (parts[0] === 'proxy') {
    const sec = (parts[1] as ProxySection) || 'console';
    return { kind: 'proxy', section: PROXY_SECTIONS.includes(sec) ? sec : 'console' };
  }
  if (parts[0] === 'docs') return { kind: 'docs' };
  if (parts[0] === 'billing') return { kind: 'billing' };
  if (parts[0] === 'account') return { kind: 'account' };
  if (parts[0] === 'admin') return { kind: 'admin', section: parts[1] === 'servers' ? 'servers' : parts[1] === 'ranks' ? 'ranks' : 'accounts' };
  return { kind: 'new' };
}

function serverHash(id: string, sec: ServerSection = 'overview'): string { return `#/s/${id}/${sec}`; }
function go(hash: string): void { if (location.hash === hash) route(); else location.hash = hash; }
function goReplace(hash: string): void { history.replaceState(null, '', hash); route(); }

// ------------------------------------------------------------- app state
const state: { servers: ServerSummary[] } = { servers: [] };
const detailCache = new Map<string, ServerDetail>();          // seed headers/meters instantly
const consoleBuf = new Map<string, { cls: string; text: string }[]>(); // console scrollback per server

// Shell nodes, created once per sign-in and kept; only `content` is swapped.
let content: HTMLElement = el('div', { class: 'content' });
let sideList: HTMLElement = el('div', { class: 'srv-list' });
let sideNav: HTMLElement = el('div', { class: 'side-nav' });
let sideFoot: HTMLElement = el('div', { class: 'side-foot' });
let balChip: HTMLElement | null = null;
const serverDots = new Map<string, HTMLElement>();

function setBal(n: number): void { if (balChip) balChip.textContent = `◈ ${n}`; }
async function refreshMe(): Promise<void> { try { me = await api.me(); if (me) setBal(me.credits); } catch { /* keep last */ } }

// ------------------------------------------------------------------ boot
async function main(): Promise<void> {
  try { meta = await api.meta(); } catch { /* non-fatal */ }
  me = await api.me().catch(() => null);
  window.addEventListener('hashchange', route);
  if (me) await showApp();
  else swapWhole(renderAuth());
}

function swapWhole(node: HTMLElement): void { dispose(); clear(app); app.append(node); }

// ------------------------------------------------------------------ auth
function renderAuth(mode: 'login' | 'register' = 'login'): HTMLElement {
  const email = el('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
  const pass = el('input', { class: 'input', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: '••••••••' });
  const msg = el('div', { class: 'form-msg' });
  const submit = el('button', { class: 'btn btn-portal btn-block', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account');

  const form = el('form', {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      msg.className = 'form-msg'; msg.textContent = '';
      submit.classList.add('is-disabled');
      try {
        const fn = mode === 'login' ? api.login : api.register;
        await fn(email.value.trim(), pass.value);
        sound.click();
        await refreshMe();
        await showApp();
      } catch (err) {
        msg.className = 'form-msg err'; msg.textContent = fail(err);
        submit.classList.remove('is-disabled');
      }
    },
  },
    el('div', { class: 'field' }, el('label', {}, 'Email'), email),
    el('div', { class: 'field' }, el('label', {}, 'Password'), pass),
    submit, msg,
  );

  const alt = el('div', { class: 'auth-alt' },
    mode === 'login' ? 'No account yet? ' : 'Already have one? ',
    el('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); swapWhole(renderAuth(mode === 'login' ? 'register' : 'login')); } },
      mode === 'login' ? 'Create one' : 'Sign in'),
  );

  return el('div', { class: 'panel-wrap' },
    el('div', { class: 'auth entry' },
      el('h2', {}, mode === 'login' ? 'Sign in' : 'Create your account'),
      el('p', { class: 'sub' },
        mode === 'login' ? 'Your dashboard is waiting.' : `One free ${meta?.plan.name ?? 'End Stone'} server, provisioned for real.`),
      form, alt,
    ),
  );
}

// ------------------------------------------------------------------ shell
async function showApp(): Promise<void> {
  content = el('div', { class: 'content' });
  sideList = el('div', { class: 'srv-list' });
  sideFoot = el('div', { class: 'side-foot' });

  const side = el('aside', { class: 'side' },
    el('div', { class: 'side-title' }, 'Your servers'),
    sideList,
    el('div', { class: 'side-nav' },
      navLink('network', '#/network', '⬡ Network'),
      ...(me?.admin ? [navLink('proxy', '#/proxy/console', '⇄ Proxy')] : []),
      navLink('docs', '#/docs', '❓ Docs'),
      navLink('billing', '#/billing', '◈ Guthaben'),
      navLink('account', '#/account', '☰ Account'),
      ...(me?.admin ? [navLink('admin', '#/admin/accounts', '⚙ Admin')] : []),
    ),
    sideFoot,
  );
  sideNav = side.querySelector('.side-nav') as HTMLElement;

  const shell = el('div', { class: 'app-wrap' }, el('div', { class: 'app' }, side, content));
  clear(app); app.append(shell);
  buildFoot();

  await loadServers();
  if (!location.hash || location.hash === '#') {
    goReplace(state.servers.length ? serverHash(state.servers[0].id, 'overview') : '#/new');
  } else {
    route();
  }
}

function navLink(kind: string, href: string, label: string): HTMLElement {
  return el('a', { class: 'side-nav-item', 'data-nav': kind, href, onclick: () => sound.click() }, label);
}

function buildFoot(): void {
  balChip = el('span', { class: 'bal-chip', title: 'Your Guthaben balance' }, `◈ ${me?.credits ?? 0}`);
  clear(sideFoot);
  sideFoot.append(
    el('div', { class: 'foot-row' }, balChip, me?.admin ? el('span', { class: 'admin-tag' }, 'admin') : ''),
    el('div', { class: 'foot-email', title: me?.email }, me?.email ?? ''),
    el('button', { class: 'btn btn-ghost btn-sm btn-block', onclick: async () => { await api.logout().catch(() => {}); me = null; location.hash = ''; swapWhole(renderAuth()); } }, 'Sign out'),
  );
}

// The left-hand server list, rebuilt whenever the set of servers changes.
function buildSidebar(): void {
  clear(sideList); serverDots.clear();
  for (const s of state.servers) {
    const dot = el('span', { class: 'srv-dot' });
    serverDots.set(s.id, dot);
    const cached = detailCache.get(s.id);
    if (cached) setDotFrom(dot, cached.state);
    sideList.append(el('a', { class: 'srv-item', 'data-srv': s.id, href: serverHash(s.id, 'overview'), onclick: () => sound.click() },
      dot,
      el('span', { class: 'srv-text' },
        el('span', { class: 'srv-name' }, s.name),
        el('span', { class: 'srv-sub' }, s.subdomain ? `${s.subdomain}.example.invalid` : `port ${s.port}`),
      ),
    ));
    void api.server(s.id).then((d) => { detailCache.set(s.id, d); setDot(s.id, d.state); }).catch(() => {});
  }
  const canCreate = !me || me.serverCount < me.serverLimit;
  const newBtn = el('a', {
    class: 'side-new' + (canCreate ? '' : ' is-full'),
    href: '#/new',
    onclick: (e: Event) => { if (!canCreate) { e.preventDefault(); toast(`You're at your limit of ${me?.serverLimit} server${me?.serverLimit === 1 ? '' : 's'}. An admin can raise it.`, 'err'); } else sound.click(); },
    title: canCreate ? 'Create a new server' : 'Server limit reached',
  }, canCreate ? '＋ New server' : `＋ New server · ${me?.serverCount}/${me?.serverLimit}`);
  sideList.append(newBtn);
  updateSideActive();
}

function setDotFrom(dot: HTMLElement, st: LiveState): void {
  let cls = 'off';
  if (st.running && st.health === 'healthy') cls = 'on';
  else if (st.running) cls = 'busy';
  dot.className = `srv-dot ${cls}`;
}
function setDot(id: string, st: LiveState): void { const dot = serverDots.get(id); if (dot) setDotFrom(dot, st); }

function updateSideActive(r: Route = parseHash()): void {
  const activeId = r.kind === 'server' ? r.id : null;
  const navKind = r.kind === 'network' || r.kind === 'proxy' || r.kind === 'docs' || r.kind === 'billing' || r.kind === 'account' || r.kind === 'admin' ? r.kind : null;
  sideList.querySelectorAll('.srv-item').forEach((n) => n.classList.toggle('active', (n as HTMLElement).dataset.srv === activeId));
  sideNav?.querySelectorAll('.side-nav-item').forEach((n) => n.classList.toggle('active', (n as HTMLElement).dataset.nav === navKind));
}

async function loadServers(): Promise<void> {
  try { state.servers = await api.servers(); } catch { state.servers = []; }
  await refreshMe();
  buildFoot();
  buildSidebar();
}

// The router: swaps only the content pane; the rail stays put.
function route(): void {
  if (!me) return;
  const r = parseHash();
  dispose();
  clear(content);
  updateSideActive(r);
  if (r.kind === 'server') {
    const s = state.servers.find((x) => x.id === r.id);
    if (!s) { content.append(el('div', { class: 'entry empty' }, 'That server no longer exists.')); return; }
    let sec = r.section;
    const hasMarket = s.kind === 'plugins' || s.kind === 'mods';
    if (sec === 'plugins' && !hasMarket) sec = 'overview';
    content.append(renderServer(s, sec));
  } else if (r.kind === 'new') content.append(renderCreate());
  else if (r.kind === 'network') content.append(renderNetwork());
  else if (r.kind === 'proxy') content.append(renderProxy(r.section));
  else if (r.kind === 'docs') content.append(renderDocs());
  else if (r.kind === 'billing') content.append(renderBilling());
  else if (r.kind === 'account') content.append(renderAccount());
  else content.append(renderAdmin(r.section));
}

// ------------------------------------------------------------------ create
function renderCreate(): HTMLElement {
  const softwares = meta?.software ?? [];
  const name = el('input', { class: 'input', placeholder: 'My End Server', maxlength: '32' });
  const motd = el('input', { class: 'input', placeholder: '§dWelcome to my server', maxlength: '59' });

  const sw = el('select', { class: 'input' }, ...softwares.map((s) => el('option', { value: s.id }, `${s.label} · ${s.kind}`))) as HTMLSelectElement;
  sw.value = meta?.defaultSoftware ?? 'paper';
  const ver = el('select', { class: 'input' }) as HTMLSelectElement;
  const swNote = el('div', { class: 'field-note t-mute' });

  function repopulate(): void {
    const chosen = softwares.find((s) => s.id === sw.value);
    const versions = chosen?.versions ?? meta?.versions ?? [];
    const prev = ver.value;
    clear(ver);
    versions.forEach((v) => ver.append(el('option', { value: v }, v)));
    if (versions.includes(prev)) ver.value = prev;
    else if (meta?.defaultVersion && versions.includes(meta.defaultVersion)) ver.value = meta.defaultVersion;
    swNote.textContent = chosen?.note ?? '';
  }
  sw.addEventListener('change', () => { sound.click(); repopulate(); });
  repopulate();

  const msg = el('div', { class: 'form-msg' });
  const btn = el('button', { class: 'btn btn-portal', type: 'submit' }, 'Create server');

  const form = el('form', {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      msg.className = 'form-msg'; msg.textContent = '';
      btn.classList.add('is-disabled'); btn.textContent = 'Provisioning…';
      try {
        const s = await api.create(name.value.trim(), ver.value, motd.value.trim(), sw.value);
        toast('Server created — booting now.');
        await loadServers();
        go(serverHash(s.id, 'overview'));
      } catch (err) {
        msg.className = 'form-msg err'; msg.textContent = fail(err);
        btn.classList.remove('is-disabled'); btn.textContent = 'Create server';
      }
    },
  },
    el('div', { class: 'field' }, el('label', {}, 'Server name'), name),
    el('div', { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', {}, 'Server software'), sw),
      el('div', { class: 'field' }, el('label', {}, 'Minecraft version'), ver),
    ),
    swNote,
    el('div', { class: 'field' }, el('label', {}, 'MOTD (optional — § colour codes work)'), motd),
    btn, msg,
  );

  const p = meta?.plan;
  const count = me ? `${me.serverCount} of ${me.serverLimit}` : '';
  return el('div', { class: 'page' },
    pageHead('Create a server', p
      ? `${p.name} · ${p.ramMB / 1024} GB RAM · up to ${p.maxPlayers} players. Boots in about a minute and sleeps when empty.`
      : 'One free server, provisioned for real.'),
    me && me.serverLimit > 1 ? el('div', { class: 'page-note t-mute sh' }, `You're using ${count} of your servers.`) : '',
    el('div', { class: 'entry pad' }, form),
  );
}

// ============================================================ network / selector
// The server selector: every listed server on the host as one network, shown as a
// Minecraft-item card and sorted by who is busiest. A server wears an item icon it
// picks in the panel, can hide itself, and — for admins — the whole thing sits in
// front of the real Velocity proxy with a console into every server.

function itemIcon(icon: string, size = 44): HTMLElement {
  return el('img', { class: 'mc-item', width: String(size), height: String(size), src: `/assets/img/items/${icon}.png?v=1`, alt: '' });
}

function playerBar(online: number, max: number): HTMLElement {
  const pct = max > 0 ? Math.min(100, Math.round((online / max) * 100)) : 0;
  return el('div', { class: 'net-bar', title: `${online} of ${max} online` }, el('i', { style: `width:${pct}%` }));
}

function copyText(value: string, e: Event): void {
  const b = e.currentTarget as HTMLElement; const t = b.textContent;
  navigator.clipboard.writeText(value)
    .then(() => { b.textContent = '✓'; setTimeout(() => (b.textContent = t), 1000); })
    .catch(() => toast('Copy failed', 'err'));
}

// A dismissible overlay. onClose runs on any close path (button, backdrop, Escape),
// so a live console socket inside it always gets torn down.
function modal(title: string, body: HTMLElement, opts: { extraClass?: string; onClose?: () => void } = {}): { close: () => void } {
  const back = el('div', { class: 'modal-back' });
  let closed = false;
  function close(): void {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey);
    back.remove();
    opts.onClose?.();
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const box = el('div', { class: `modal ${opts.extraClass || ''}` },
    el('div', { class: 'modal-head' }, el('span', { class: 'k' }, title), el('button', { class: 'btn btn-ghost btn-sm', onclick: close }, '✕ Close')),
    body,
  );
  back.append(box);
  back.addEventListener('click', (e: Event) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return { close };
}

// A live console in an overlay — reads the real server (or proxy) log over the
// WebSocket and types straight back into it. wsPath decides which console: a
// server's, or the proxy's Velocity terminal.
function openConsole(title: string, wsPath: string): void {
  const out = el('div', { class: 'console-out mono' });
  const cmd = el('input', { class: 'input', placeholder: 'type a command…', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  function push(text: string, cls = 'l-info'): void {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.append(el('div', { class: cls }, text));
    while (out.childElementCount > 500) out.firstChild && out.removeChild(out.firstChild);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws: WebSocket | null = new WebSocket(`${proto}://${location.host}${wsPath}`);
  push('[endhost] connecting…', 'l-sys');
  ws.onmessage = (e) => String(e.data).split('\n').forEach((line) => {
    if (!line) return;
    let cls = 'l-info';
    if (/\bWARN\b/.test(line)) cls = 'l-warn';
    if (/ERROR|FATAL|Exception/.test(line)) cls = 'l-err';
    if (/joined the game|left the game|has connected|connected to|-> /.test(line)) cls = 'l-you';
    if (line.startsWith('[endhost]')) cls = 'l-sys';
    push(line, cls);
  });
  ws.onclose = () => push('[endhost] console closed.', 'l-sys');
  ws.onerror = () => push('[endhost] console error.', 'l-err');

  const form = el('form', { class: 'console-form',
    onsubmit: (e: Event) => { e.preventDefault(); const c = cmd.value.trim(); if (!c) return; cmd.value = ''; push(`> ${c}`, 'l-you'); try { ws?.send(c); } catch { /* closed */ } },
  }, el('span', { class: 'prompt' }, '>'), cmd, el('button', { class: 'btn btn-sm', type: 'submit' }, 'Send'));

  const body = el('div', { class: 'console-modal-body' }, out, form);
  modal(title, body, { extraClass: 'modal-console', onClose: () => { ws?.close(); ws = null; } });
  setTimeout(() => cmd.focus(), 50);
}

// A grid of every item a server can wear; clicking one saves it immediately.
function openIconPicker(s: { id: string; name: string; icon: string }, iconWrap: HTMLElement): void {
  const icons = meta?.itemIcons ?? [];
  const grid = el('div', { class: 'item-picker' });
  icons.forEach((ic) => {
    const cell = el('button', { class: 'item-cell' + (ic === s.icon ? ' active' : ''), title: ic.replace(/_/g, ' '),
      onclick: async () => {
        try {
          await api.setIcon(s.id, ic);
          s.icon = ic;
          clear(iconWrap); iconWrap.append(itemIcon(ic, 46));
          grid.querySelectorAll('.item-cell').forEach((c) => c.classList.remove('active'));
          cell.classList.add('active');
          toast(`${s.name} now wears ${ic.replace(/_/g, ' ')}`);
        } catch (e) { toast(fail(e), 'err'); }
      },
    }, itemIcon(ic, 40));
    grid.append(cell);
  });
  modal(`Choose ${s.name}'s icon`, grid, { extraClass: 'modal-picker' });
}

function syncMine(id: string, listed: boolean): void {
  const s = state.servers.find((x) => x.id === id);
  if (s) s.listed = listed;
}

function renderNetwork(): HTMLElement {
  const mine = new Set(state.servers.map((s) => s.id));
  const isAdmin = !!me?.admin;

  const banner = el('div', { class: 'net-banner entry' }, el('div', { class: 'loading blink', style: 'padding:8px' }, 'Loading the network '));
  const proxyHolder = el('div', {});
  const grid = el('div', { class: 'net-grid' });
  const hidden = el('div', {});

  function statusPill(running: boolean): HTMLElement {
    return el('span', { class: 'net-pill ' + (running ? 'on' : 'off') }, el('span', { class: 'dot ' + (running ? 'on' : 'off') }), running ? 'Online' : 'Asleep');
  }

  function card(s: NetworkServer): HTMLElement {
    const canEdit = isAdmin || mine.has(s.id);
    const iconWrap = el('div', { class: 'net-ic slot' }, itemIcon(s.icon, 46));

    const addr = el('div', { class: 'net-addr' }, el('code', {}, s.address),
      el('button', { class: 'btn btn-ghost btn-xs', title: 'Copy address', onclick: (e: Event) => copyText(s.address, e) }, 'copy'));

    const actions = el('div', { class: 'net-actions' });
    if (canEdit) {
      actions.append(
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openIconPicker(s, iconWrap) }, '❖ Icon'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: async (e: Event) => {
          const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
          try { await api.setListed(s.id, false); syncMine(s.id, false); toast(`${s.name} hidden from the selector`); await load(); }
          catch (err) { toast(fail(err), 'err'); b.classList.remove('is-disabled'); }
        } }, '⊘ Hide'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openConsole(`${s.name} — console`, `/api/servers/${s.id}/console`) }, '⌨ Console'),
      );
    }

    return el('div', { class: 'net-card entry' + (s.running ? ' is-live' : '') },
      el('div', { class: 'net-top' },
        iconWrap,
        el('div', { class: 'net-body' },
          el('div', { class: 'net-title' }, s.name, mine.has(s.id) ? el('span', { class: 'net-you' }, 'yours') : ''),
          el('div', { class: 'net-motd', html: motdToHtml(s.motd || s.softwareLabel) }),
        ),
        el('div', { class: 'net-meta' }, statusPill(s.running), el('div', { class: 'net-count' }, el('b', {}, String(s.online)), `/${s.maxPlayers}`)),
      ),
      playerBar(s.online, s.maxPlayers),
      el('div', { class: 'net-foot' }, addr, el('span', { class: 'net-sw t-mute sh' }, `${s.softwareLabel} · ${s.version}`)),
      actions.childElementCount ? actions : '',
    );
  }

  function hiddenCard(sm: ServerSummary): HTMLElement {
    return el('div', { class: 'net-hidden-row entry' },
      itemIcon(sm.icon, 28),
      el('span', { class: 'nh-name' }, sm.name),
      el('span', { class: 't-mute sh' }, 'hidden — only you see this'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
        try { await api.setListed(sm.id, true); syncMine(sm.id, true); toast(`${sm.name} is on the selector again`); await load(); }
        catch (err) { toast(fail(err), 'err'); b.classList.remove('is-disabled'); }
      } }, 'Show'),
    );
  }

  async function load(): Promise<void> {
    let info;
    try { info = await api.network(); }
    catch (e) { clear(banner); banner.append(el('div', { class: 'err-line' }, fail(e))); return; }

    const on = info.network.running;
    clear(banner);
    banner.className = 'net-banner entry' + (on ? ' is-on' : '');
    banner.append(
      el('div', { class: 'net-banner-l' },
        el('div', { class: 'label mb' }, 'The network'),
        el('div', { class: 'net-join' }, el('code', {}, info.network.address),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: (e: Event) => copyText(info.network.address, e) }, 'copy')),
        el('div', { class: 't-mute sh' }, on
          ? `Proxy online · ${info.network.backends} server${info.network.backends === 1 ? '' : 's'} linked — join once, switch server in-game.`
          : 'Each server below also has its own address. The in-game proxy is currently off.'),
      ),
      el('div', { class: 'net-banner-r' },
        el('div', { class: 'net-online-big' }, el('b', {}, String(info.online)), el('span', { class: 't-mute sh' }, ` player${info.online === 1 ? '' : 's'} online`)),
        el('span', { class: 'net-pill ' + (on ? 'on' : 'off') }, el('span', { class: 'dot ' + (on ? 'on' : 'off') }), on ? 'Proxy on' : 'Proxy off'),
      ),
    );

    clear(grid);
    if (!info.servers.length) grid.append(el('div', { class: 'entry empty' }, 'No servers are on the network yet. Create one, and it shows up here.'));
    else info.servers.forEach((s) => grid.append(card(s)));

    clear(hidden);
    const myHidden = state.servers.filter((s) => s.listed === false);
    if (myHidden.length) {
      hidden.append(el('div', { class: 'label mb', style: 'margin-top:20px' }, 'Hidden from the selector'),
        el('div', { class: 'net-hidden' }, ...myHidden.map(hiddenCard)));
    }
  }

  void load();
  const timer = window.setInterval(() => void load(), 8000);
  onDispose(() => window.clearInterval(timer));

  if (isAdmin) { buildMaintenanceControl(proxyHolder); buildProxyControl(proxyHolder, load); buildNetworkSettings(proxyHolder); }

  return el('div', { class: 'page' },
    pageHead('Network', 'Every server on Endhost as one network — sorted by who’s busiest. Give a server its own item icon, hide it from the list, or drop straight into its console.'),
    banner,
    proxyHolder,
    grid,
    hidden,
  );
}

// The master power switch. One click vacates every Minecraft port this panel runs —
// the Velocity proxy (25565), the subdomain router (25580) and all running servers —
// so the whole 25565–25580 range is free for the live network next door to reclaim.
// The panel, its API and SFTP keep running, so everything can be brought back here.
function buildMaintenanceControl(container: HTMLElement): void {
  const body = el('div', { class: 'maint-body' }, el('div', { class: 'loading blink', style: 'padding:8px' }, 'Loading '));
  const card = el('div', { class: 'entry proxy-card maint-card' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Host power'), el('span', { class: 'k t-mute' }, 'ports 25565–25580 · admin only')),
    body,
  );
  container.append(card);

  async function act(on: boolean, btn: HTMLElement): Promise<void> {
    btn.classList.add('is-disabled');
    try {
      await api.adminSetMaintenance(on);
      toast(on ? 'Everything shut down — ports 25565–25580 are free.' : 'Services back up.');
      await load();
    } catch (e) { toast(fail(e), 'err'); btn.classList.remove('is-disabled'); }
  }

  async function load(): Promise<void> {
    let m: MaintenanceInfo;
    try { m = await api.adminMaintenance(); }
    catch (e) { clear(body); body.append(el('div', { class: 'err-line' }, fail(e))); return; }
    clear(body);
    card.classList.toggle('is-down', m.on);

    const pill = el('span', { class: 'net-pill ' + (m.on ? 'off' : 'on') },
      el('span', { class: 'dot ' + (m.on ? 'off' : 'on') }),
      m.on ? 'Shut down — ports free' : 'Services running');

    const detail = m.on
      ? `Ports ${m.proxyPort}–${m.routerPort} are free. The panel and SFTP are still up.`
      : `Router on :${m.routerPort}${m.proxyRunning ? ` · proxy on :${m.proxyPort}` : ''} · ${m.runningServers} server${m.runningServers === 1 ? '' : 's'} running`;

    const btn = m.on
      ? el('button', { class: 'btn btn-portal btn-sm', onclick: (e: Event) => act(false, e.currentTarget as HTMLElement) }, '▶ Bring services back')
      : el('button', { class: 'btn btn-danger btn-sm', onclick: (e: Event) => {
          if (!window.confirm('Shut everything down?\n\nThis stops the network proxy (port 25565), the subdomain router (port 25580) and every running server, freeing ports 25565–25580. Any online players are disconnected.\n\nThe panel and SFTP stay up, so you can bring it all back from here.')) return;
          void act(true, e.currentTarget as HTMLElement);
        } }, '■ Shut everything down');

    body.append(
      el('div', { class: 'proxy-status' }, pill, el('span', { class: 't-mute sh' }, detail)),
      el('p', { class: 'set-lead t-mute sh' }, 'One switch to vacate every Minecraft port this panel runs — the network proxy (25565), the subdomain router (25580) and all running servers — so the range 25565–25580 is free for the live network to reclaim. The panel, its API and SFTP keep running, so you can bring everything back from here.'),
      el('div', { class: 'proxy-btns' }, btn),
    );
  }

  void load();
  const t = window.setInterval(() => void load(), 12000);
  onDispose(() => window.clearInterval(t));
}

// The admin's proxy control: run the real Velocity proxy, and manage every server's
// listing and console from one place. Deliberately admin-only.
function buildProxyControl(container: HTMLElement, reloadSelector: () => Promise<void>): void {
  const body = el('div', { class: 'proxy-body' }, el('div', { class: 'loading blink', style: 'padding:8px' }, 'Loading proxy '));
  container.append(el('div', { class: 'entry proxy-card' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Network proxy'), el('span', { class: 'k t-mute' }, 'Velocity · admin only')),
    body,
  ));

  async function act(action: ProxyAction, opts: { motd?: string } = {}, btn?: HTMLElement): Promise<void> {
    if (btn) btn.classList.add('is-disabled');
    try { await api.adminProxy(action, opts); await load(); await reloadSelector(); toast('Proxy updated.'); }
    catch (e) { toast(fail(e), 'err'); if (btn) btn.classList.remove('is-disabled'); }
  }

  function adminRow(s: AdminNetworkServer): HTMLElement {
    return el('div', { class: 'proxy-row' },
      itemIcon(s.icon, 24),
      el('span', { class: 'pr-name' }, s.name, el('span', { class: 'pr-owner t-mute sh' }, s.owner)),
      el('span', { class: 'pr-count t-mute sh' }, s.running ? `${s.online} online` : 'asleep'),
      s.inProxy ? el('span', { class: 'pr-tag' }, 'linked') : (s.listed ? el('span', { class: 'pr-tag muted' }, 'listed') : ''),
      el('button', { class: 'btn btn-ghost btn-xs', onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
        try { await api.setListed(s.id, !s.listed); syncMine(s.id, !s.listed); await load(); await reloadSelector(); }
        catch (err) { toast(fail(err), 'err'); b.classList.remove('is-disabled'); }
      } }, s.listed ? 'Hide' : 'Show'),
      el('button', { class: 'btn btn-ghost btn-xs', onclick: () => openConsole(`${s.name} — console`, `/api/servers/${s.id}/console`) }, 'Console'),
    );
  }

  async function load(): Promise<void> {
    let info;
    try { info = await api.adminNetwork(); }
    catch (e) { clear(body); body.append(el('div', { class: 'err-line' }, fail(e))); return; }
    const p = info.proxy;
    clear(body);

    const stateLabel = p.running ? 'Running' : (p.exists ? 'Stopped' : (p.provisioned ? 'Not started' : 'Not provisioned'));
    const motd = el('input', { class: 'input', value: p.motd, maxlength: '120', spellcheck: 'false' }) as HTMLInputElement;

    const btnUp = el('button', { class: 'btn btn-portal btn-sm', onclick: (e: Event) => act('up', { motd: motd.value }, e.currentTarget as HTMLElement) }, p.running ? '↻ Restart proxy' : '▶ Turn proxy on');
    const btns = el('div', { class: 'proxy-btns' }, btnUp);
    if (p.running) {
      btns.append(
        el('button', { class: 'btn btn-ghost btn-sm', onclick: (e: Event) => act('refresh', { motd: motd.value }, e.currentTarget as HTMLElement) }, '⟳ Reload servers'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openConsole('Proxy — Velocity console', '/api/network/console') }, '⌨ Proxy console'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: (e: Event) => act('down', {}, e.currentTarget as HTMLElement) }, '■ Turn off'),
      );
    } else {
      btns.append(el('button', { class: 'btn btn-ghost btn-sm', onclick: (e: Event) => act('motd', { motd: motd.value }, e.currentTarget as HTMLElement) }, 'Save MOTD'));
      if (p.exists) btns.append(el('button', { class: 'btn btn-ghost btn-sm', onclick: (e: Event) => act('destroy', {}, e.currentTarget as HTMLElement) }, '🗑 Remove container'));
    }

    body.append(
      el('div', { class: 'proxy-status' },
        el('span', { class: 'net-pill ' + (p.running ? 'on' : 'off') }, el('span', { class: 'dot ' + (p.running ? 'on' : 'off') }), stateLabel),
        el('span', { class: 't-mute sh' }, `${p.address} · ${p.backends} linked`),
      ),
      el('p', { class: 'set-lead t-mute sh' }, 'The whole host is one Velocity network: players join the proxy and land on the Lobby, then pick a server from the /servers menu (or /server <name>). Every server here is a sub-server. The proxy runs the Via stack, so any client version can join, whatever version each server runs. Turning it off makes every server unreachable — use Host power above to shut the whole network down.'),
      el('div', { class: 'field' }, el('label', {}, 'Proxy MOTD (fallback)'), motd),
      btns,
      el('div', { class: 'label mb', style: 'margin-top:16px' }, `All servers · ${info.servers.length}`),
      el('div', { class: 'proxy-list' }, ...info.servers.map(adminRow)),
    );
  }

  void load();
  const t = window.setInterval(() => void load(), 12000);
  onDispose(() => window.clearInterval(t));
}

// The EndhostProxy network settings: the server-list MOTD, a maintenance mode that shows a
// second MOTD and only lets whitelisted players in (without taking the proxy offline), and
// the whitelist itself. Loaded once and reloaded after each action so a half-typed MOTD is
// never wiped by a background refresh.
function buildNetworkSettings(container: HTMLElement): void {
  const body = el('div', { class: 'proxy-body' }, el('div', { class: 'loading blink', style: 'padding:8px' }, 'Loading '));
  container.append(el('div', { class: 'entry proxy-card' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Server list & maintenance'), el('span', { class: 'k t-mute' }, 'EndhostProxy · admin only')),
    body,
  ));

  async function load(): Promise<void> {
    let info;
    try { info = await api.adminNetwork(); }
    catch (e) { clear(body); body.append(el('div', { class: 'err-line' }, fail(e))); return; }
    const n = info.net;
    clear(body);

    const area = (value: string): HTMLTextAreaElement => {
      const t = el('textarea', { class: 'input', rows: '2', maxlength: '200', spellcheck: 'false' }) as HTMLTextAreaElement;
      t.value = value;
      return t;
    };
    const normal = area(n.motdNormal);
    const maint = area(n.motdMaintenance);
    const kick = area(n.kickMessage);

    async function saveMsgs(btn: HTMLElement): Promise<void> {
      btn.classList.add('is-disabled');
      try { await api.adminNetMotd({ normal: normal.value, maintenance: maint.value, kick: kick.value }); toast('Messages saved.'); }
      catch (e) { toast(fail(e), 'err'); }
      btn.classList.remove('is-disabled');
    }
    async function setMaint(on: boolean, btn: HTMLElement): Promise<void> {
      btn.classList.add('is-disabled');
      try { await api.adminNetMaintenance(on); toast(on ? 'Maintenance on — only whitelisted players can join.' : 'Maintenance off.'); await load(); }
      catch (e) { toast(fail(e), 'err'); btn.classList.remove('is-disabled'); }
    }
    async function addWl(name: string): Promise<void> {
      if (!name) return;
      try { await api.adminNetWhitelist('add', [name]); await load(); }
      catch (e) { toast(fail(e), 'err'); }
    }
    async function removeWl(name: string, btn: HTMLElement): Promise<void> {
      btn.classList.add('is-disabled');
      try { await api.adminNetWhitelist('remove', [name]); await load(); }
      catch (e) { toast(fail(e), 'err'); btn.classList.remove('is-disabled'); }
    }

    const toggleBtn = n.maintenance
      ? el('button', { class: 'btn btn-portal btn-sm', onclick: (e: Event) => void setMaint(false, e.currentTarget as HTMLElement) }, '▶ End maintenance')
      : el('button', { class: 'btn btn-danger btn-sm', onclick: (e: Event) => void setMaint(true, e.currentTarget as HTMLElement) }, '⚠ Start maintenance');

    const wlInput = el('input', { class: 'input pl-input', placeholder: 'Minecraft name', maxlength: '40', autocomplete: 'off' }) as HTMLInputElement;
    const wlAdd = el('form', { class: 'pl-add', onsubmit: (e: Event) => { e.preventDefault(); const v = wlInput.value.trim(); wlInput.value = ''; void addWl(v); } },
      wlInput, el('button', { class: 'btn btn-sm btn-portal', type: 'submit' }, 'Add'));
    const wlRows = n.whitelist.length
      ? n.whitelist.map((name) => el('div', { class: 'proxy-row' },
          el('span', { class: 'pr-name' }, name),
          el('button', { class: 'btn btn-ghost btn-xs', onclick: (e: Event) => void removeWl(name, e.currentTarget as HTMLElement) }, 'Remove')))
      : [el('div', { class: 'pl-empty' }, 'Only the seeded operator can join during maintenance.')];

    body.append(
      el('div', { class: 'proxy-status' },
        el('span', { class: 'net-pill ' + (n.maintenance ? 'off' : 'on') }, el('span', { class: 'dot ' + (n.maintenance ? 'off' : 'on') }), n.maintenance ? 'Maintenance on' : 'Open to everyone'),
        el('span', { class: 't-mute sh' }, 'This is what the server list shows and who may join — the proxy stays up.'),
      ),
      el('p', { class: 'set-lead t-mute sh' }, 'The MOTD players see in their server list, plus a maintenance mode that switches to the second MOTD and turns away anyone not on the whitelist — without taking the network offline. Colour codes with & work; use two lines with a line break.'),
      el('div', { class: 'field' }, el('label', {}, 'Normal MOTD'), normal),
      el('div', { class: 'field' }, el('label', {}, 'Maintenance MOTD'), maint),
      el('div', { class: 'field' }, el('label', {}, 'Maintenance kick message'), kick),
      el('div', { class: 'proxy-btns' },
        el('button', { class: 'btn btn-ghost btn-sm', onclick: (e: Event) => void saveMsgs(e.currentTarget as HTMLElement) }, 'Save messages'),
        toggleBtn,
      ),
      el('div', { class: 'label mb', style: 'margin-top:16px' }, `Maintenance whitelist · ${n.whitelist.length}`),
      el('div', { class: 'proxy-list' }, ...wlRows),
      wlAdd,
    );
  }

  void load();
}

// ------------------------------------------------------------------ proxy view
// The Velocity proxy managed like any other server: its live console, its whole file tree, and
// its power/network settings. Admin only — it fronts the entire host.
function proxySubnav(section: ProxySection): HTMLElement {
  const item = (id: ProxySection, label: string) =>
    el('a', { class: 'sv-nav-item' + (section === id ? ' active' : ''), href: `#/proxy/${id}`, onclick: () => sound.click() }, label);
  return el('div', { class: 'sv-nav' }, item('console', 'Console'), item('files', 'Files'), item('settings', 'Settings'));
}

// The proxy's real Velocity terminal, embedded in the page: docker logs streamed in, commands
// typed straight back over the same WebSocket the modal console uses.
function buildProxyConsoleNode(): HTMLElement {
  const out = el('div', { class: 'console-out mono' });
  const cmd = el('input', { class: 'input', placeholder: 'type a Velocity command, e.g. server', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  function push(text: string, cls = 'l-info'): void {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.append(el('div', { class: cls }, text));
    while (out.childElementCount > 500) out.firstChild && out.removeChild(out.firstChild);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws: WebSocket | null = new WebSocket(`${proto}://${location.host}/api/network/console`);
  push('[endhost] connecting to the proxy console…', 'l-sys');
  ws.onmessage = (e) => String(e.data).split('\n').forEach((line) => {
    if (!line) return;
    let cls = 'l-info';
    if (/\bWARN\b/.test(line)) cls = 'l-warn';
    if (/ERROR|FATAL|Exception/.test(line)) cls = 'l-err';
    if (/has connected|-> |is now connected/.test(line)) cls = 'l-you';
    if (line.startsWith('[endhost]')) cls = 'l-sys';
    push(line, cls);
  });
  ws.onclose = () => push('[endhost] console closed.', 'l-sys');
  ws.onerror = () => push('[endhost] console error.', 'l-err');
  onDispose(() => { ws?.close(); ws = null; });

  const form = el('form', { class: 'console-form',
    onsubmit: (e: Event) => { e.preventDefault(); const c = cmd.value.trim(); if (!c) return; cmd.value = ''; push(`> ${c}`, 'l-you'); try { ws?.send(c); } catch { /* closed */ } },
  }, el('span', { class: 'prompt' }, '>'), cmd, el('button', { class: 'btn btn-sm', type: 'submit' }, 'Send'));

  const quicks: [string, string][] = [['Servers', 'server'], ['Players', 'glist'], ['Reload', 'velocity reload']];
  const quick = el('div', { class: 'console-quick' }, el('span', { class: 'cq-label' }, 'Quick:'),
    ...quicks.map(([label, c]) => el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { push(`> ${c}`, 'l-you'); try { ws?.send(c); } catch { /* closed */ } } }, label)));

  return el('div', { class: 'entry console' },
    el('div', { class: 'console-head' }, el('span', { class: 'k' }, 'Proxy console'), el('span', { class: 'k t-mute' }, 'Velocity · live')),
    out, quick, form,
  );
}

function renderProxy(section: ProxySection): HTMLElement {
  if (!me?.admin) return el('div', { class: 'page' }, pageHead('Proxy', 'Admins only.'), el('div', { class: 'entry empty' }, 'The network proxy is managed by admins.'));
  let body: HTMLElement;
  if (section === 'files') body = renderFiles(proxyFileOps(), 'velocity.toml · plugins · config');
  else if (section === 'settings') { body = el('div', {}); buildMaintenanceControl(body); buildProxyControl(body, async () => {}); buildNetworkSettings(body); }
  else body = buildProxyConsoleNode();
  return el('div', { class: 'page' },
    pageHead('Proxy', 'The Velocity proxy is a server too — its live console, its whole file tree, and its power and network settings, all in one place.'),
    proxySubnav(section),
    body,
  );
}

// ------------------------------------------------------------------- docs view
// A plain, honest command reference. Everything here is a real command one of the two plugins
// registers; the in-game /help mirrors it. Grouped by who can run it.
interface DocCmd { cmd: string; desc: string; }
interface DocGroup { title: string; note: string; cmds: DocCmd[]; }
const DOC_GROUPS: DocGroup[] = [
  {
    title: 'Everyone', note: 'Open to every player, anywhere on the network.',
    cmds: [
      { cmd: '/help', desc: 'Show the in-game command list (staff see the staff tools too).' },
      { cmd: '/hub · /lobby · /l', desc: 'Jump back to the lobby from any server.' },
      { cmd: '/spawn', desc: 'Teleport to the hub spawn while in the lobby.' },
      { cmd: '/servers · /menu', desc: 'Open the server selector.' },
      { cmd: '/players', desc: 'Show or hide other players in the lobby.' },
      { cmd: '/rank [player]', desc: "See your own or another player's rank." },
    ],
  },
  {
    title: 'Your servers', note: 'Link your Minecraft account once on the Account page, then control your own servers from in-game.',
    cmds: [
      { cmd: '/link <code>', desc: 'Bind your Minecraft account to this panel account (one-time code).' },
      { cmd: '/myservers', desc: 'List the servers you own and whether each is online.' },
      { cmd: '/start <server>', desc: 'Start one of your servers.' },
      { cmd: '/stop <server>', desc: 'Stop one of your servers.' },
      { cmd: '/restart <server>', desc: 'Restart one of your servers.' },
    ],
  },
  {
    title: 'Staff', note: 'Gated by the rank permission nodes — assign them on the Admin → Ranks page.',
    cmds: [
      { cmd: '/gm · /gmc · /gms · /gma · /gmsp [player]', desc: 'Change game mode.' },
      { cmd: '/fly [player]', desc: 'Toggle real flight (everyone still has the double-jump).' },
      { cmd: '/speed <1-10>', desc: 'Set your fly/walk speed.' },
      { cmd: '/tp <player> · /tphere <player>', desc: 'Teleport to or summon a player.' },
      { cmd: '/heal [player] · /feed [player]', desc: 'Restore health / hunger.' },
      { cmd: '/vanish · /v', desc: 'Hide yourself from non-staff.' },
      { cmd: '/broadcast <msg> · /bc', desc: 'Announce a message to the lobby.' },
      { cmd: '/clearchat · /cc', desc: 'Clear chat for everyone.' },
      { cmd: '/day · /night', desc: 'Set the hub time.' },
      { cmd: '/setspawn', desc: 'Set the hub spawn to where you stand.' },
      { cmd: '/lobbyreload · /lr', desc: 'Reload lobby config, ranks and the server list.' },
      { cmd: '/maintenance [on|off]', desc: 'Toggle network maintenance (turns non-staff away).' },
    ],
  },
];

function renderDocs(): HTMLElement {
  const groups = DOC_GROUPS.map((g) => {
    const rows = g.cmds.map((c) => el('div', { class: 'doc-row' },
      el('code', { class: 'doc-cmd' }, c.cmd),
      el('span', { class: 'doc-desc t-mute sh' }, c.desc),
    ));
    return el('div', { class: 'entry adm', style: 'margin-top:16px' },
      el('div', { class: 'card-head' }, el('span', { class: 'k' }, g.title), el('span', { class: 'k t-mute' }, `${g.cmds.length} commands`)),
      el('p', { class: 'set-lead t-mute sh' }, g.note),
      el('div', { class: 'doc-list' }, ...rows),
    );
  });
  const intro = el('div', { class: 'entry pad' },
    el('p', { class: 'set-lead t-mute sh' },
      'Every command the network understands, and who can run it. The same list is in-game as ',
      el('code', {}, '/help'), '. The owner commands need your Minecraft account linked — do that on your ',
      el('a', { class: 'crumb', href: '#/account' }, 'Account page'), '.'),
  );
  return el('div', { class: 'page' }, pageHead('Docs', 'Command reference for the whole network — lobby, proxy and your own servers.'), intro, ...groups);
}

// ------------------------------------------------------------------ server view
interface NavDef { id: ServerSection; label: string; }

function serverSections(s: ServerSummary): NavDef[] {
  const hasMarket = s.kind === 'plugins' || s.kind === 'mods';
  const marketLabel = s.kind === 'mods' ? 'Mods' : 'Plugins';
  const defs: NavDef[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'console', label: 'Console' },
    { id: 'players', label: 'Players' },
    { id: 'world', label: 'World' },
    { id: 'files', label: 'Files' },
    ...(hasMarket ? [{ id: 'plugins' as ServerSection, label: marketLabel }] : []),
    { id: 'backups', label: 'Backups' },
    { id: 'schedule', label: 'Schedule' },
    { id: 'network', label: 'Address' },
    { id: 'access', label: 'Access' },
    { id: 'settings', label: 'Settings' },
  ];
  return defs;
}

// The context header above every server section: a small label, the section's
// name and one honest line about what the page is for. It gives each page room to
// breathe instead of dropping the visitor straight onto a dense card.
function sectionHead(summary: ServerSummary, section: ServerSection): HTMLElement {
  const marketLabel = summary.kind === 'mods' ? 'Mods' : 'Plugins';
  const M: Record<ServerSection, { eyebrow: string; title: string; desc: string }> = {
    overview: { eyebrow: 'Server',     title: 'Overview',      desc: 'Live status, the address players join by, and how the machine is holding up.' },
    console:  { eyebrow: 'Server',     title: 'Console',       desc: 'The server’s own log, and a command line straight into it over RCON.' },
    players:  { eyebrow: 'Server',     title: 'Players',       desc: 'Who is on now, alongside the operator, whitelist and ban lists.' },
    world:    { eyebrow: 'Gameplay',   title: 'World settings', desc: 'Difficulty and gamerules. These save into the world, so they hold across restarts.' },
    files:    { eyebrow: 'Storage',    title: 'Files',         desc: 'Browse and edit the world, configs, plugins and mods directly in the browser.' },
    plugins:  { eyebrow: 'Content',    title: marketLabel,     desc: `Search Modrinth and install ${marketLabel.toLowerCase()} straight onto this server.` },
    backups:  { eyebrow: 'Storage',    title: 'Backups',       desc: 'Snapshot the entire world to one file — keep it, download it, or roll back to it.' },
    schedule: { eyebrow: 'Automation', title: 'Schedule',      desc: 'Automated tasks — a nightly restart, a scheduled backup, a timed command. They run on their own.' },
    network:  { eyebrow: 'Connection', title: 'Address',       desc: 'The address players join by, and a custom domain of your own if you want one.' },
    access:   { eyebrow: 'Connection', title: 'Access',        desc: 'SFTP details for moving whole folders with FileZilla, WinSCP or Cyberduck.' },
    settings: { eyebrow: 'Server',     title: 'Settings',      desc: 'The facts about this server, and the danger zone.' },
  };
  const m = M[section];
  return el('div', { class: 'sv-sec-head' },
    el('span', { class: 'sv-sec-eyebrow' }, m.eyebrow),
    el('h3', {}, m.title),
    el('p', {}, m.desc),
  );
}

function renderServer(summary: ServerSummary, section: ServerSection): HTMLElement {
  const root = el('div', { class: 'sv' });
  const pill = el('span', { class: 'state-pill' });
  const controls = el('div', { class: 'sv-controls' });

  const head = el('div', { class: 'sv-head' },
    el('div', { class: 'sv-id' }, el('h2', {}, summary.name, pill), el('div', { class: 'sv-meta t-mute' }, `${summary.softwareLabel} · Minecraft ${summary.version}`)),
    controls,
  );

  const nav = el('div', { class: 'sv-nav' });
  serverSections(summary).forEach((d) => nav.append(
    el('a', { class: 'sv-nav-item' + (d.id === section ? ' active' : ''), href: serverHash(summary.id, d.id), 'data-sec': d.id, onclick: () => sound.click() }, d.label),
  ));

  // ---- the section body, plus any live hooks it needs
  let ov: OverviewRefs | null = null;
  let cons: { node: HTMLElement; connect: () => void; drop: () => void } | null = null;
  let body: HTMLElement;
  if (section === 'overview') { const o = overviewPane(summary); ov = o.refs; body = o.node; }
  else if (section === 'console') { cons = buildConsole(summary.id); body = cons.node; }
  else if (section === 'players') body = renderPlayers(summary.id);
  else if (section === 'world') body = renderWorld(summary.id);
  else if (section === 'files') body = renderFiles(serverFileOps(summary.id));
  else if (section === 'plugins') body = renderMarket(summary.id, summary.kind as 'plugins' | 'mods');
  else if (section === 'backups') body = renderBackups(summary);
  else if (section === 'schedule') body = renderSchedule(summary.id);
  else if (section === 'network') body = networkPane(summary);
  else if (section === 'access') body = renderSftp(summary.id);
  else body = settingsPane(summary);

  root.append(head, nav, el('div', { class: 'sv-body' }, sectionHead(summary, section), body));

  // ---- power controls + status, rebuilt from real state each poll
  function powerBtn(label: string, cls: string, fn: () => Promise<unknown>): HTMLElement {
    return el('button', { class: `btn ${cls}`,
      onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
        try { await fn(); await refresh(); } catch (err) { toast(fail(err), 'err'); b.classList.remove('is-disabled'); }
      },
    }, label);
  }

  function updateHeader(d: ServerDetail): void {
    const st = d.state;
    let dotCls = 'off', label = 'Asleep';
    if (!st.exists) { dotCls = 'off'; label = 'Not created'; }
    else if (st.running && st.health === 'healthy') { dotCls = 'on'; label = 'Online'; }
    else if (st.running && (st.health === 'starting' || st.health === null)) { dotCls = 'busy'; label = 'Starting…'; }
    else if (st.running) { dotCls = 'busy'; label = 'Running'; }
    clear(pill); pill.append(el('span', { class: `dot ${dotCls}` }), el('span', { class: 'sh' }, label));
    setDot(summary.id, st);

    clear(controls);
    if (st.running) {
      controls.append(powerBtn('Restart', 'btn-sm', () => api.restart(summary.id)), powerBtn('Stop', 'btn-sm btn-ghost', () => api.stop(summary.id)));
    } else {
      controls.append(powerBtn('Start', 'btn-sm btn-portal', () => api.start(summary.id)));
    }
    const aoOn = d.alwaysOn;
    controls.append(el('button', {
      class: `btn btn-sm ${aoOn ? 'btn-portal' : 'btn-ghost'}`,
      title: aoOn ? 'Paid to stay awake — click to let it sleep again' : 'Keep awake past idle (costs credits/hour)',
      onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
        try { await api.alwaysOn(summary.id, !aoOn); await refreshMe(); await refresh(); }
        catch (err) { toast(fail(err), 'err'); b.classList.remove('is-disabled'); }
      },
    }, aoOn ? '☀ Always-on' : '☾ Always-on'));
  }

  async function refresh(): Promise<void> {
    let d: ServerDetail;
    try { d = await api.server(summary.id); } catch { return; }
    detailCache.set(summary.id, d);
    updateHeader(d);
    if (ov) updateOverview(ov, d);
    if (cons) { if (d.state.running) cons.connect(); else cons.drop(); }
  }

  const seed = detailCache.get(summary.id);
  if (seed) { updateHeader(seed); if (ov) updateOverview(ov, seed); }
  const timer = window.setInterval(refresh, 3000);
  onDispose(() => window.clearInterval(timer));
  void refresh();

  return root;
}

// A player's real face, rendered from their skin (servers run online-mode, so the
// name maps to an account). Falls back to hidden if the avatar service is down, so
// the pixel-slot placeholder underneath shows instead.
function avatar(name: string, size = 22): HTMLElement {
  const wrap = el('span', { class: 'mc-avatar', style: `width:${size}px;height:${size}px` });
  const img = el('img', { width: size, height: size, alt: '', loading: 'lazy', src: `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}` }) as HTMLImageElement;
  img.addEventListener('error', () => { img.remove(); });
  wrap.append(img);
  return wrap;
}

// ---- overview: performance graph + activity feed
function eventGlyph(kind: string): string {
  return ({ start: '▶', stop: '■', restart: '↻', backup: '⧉', schedule: '◷', domain: '⌂', 'always-on': '☀' } as Record<string, string>)[kind] || '·';
}

function drawGraph(info: MetricsInfo): string {
  const pts = info.points;
  const W = 640, H = 150, pad = 8;
  if (pts.length < 2) {
    return `<div class="ov-graph-empty t-mute sh">${pts.length ? 'collecting data — the line fills in as it samples' : 'no samples yet — while the server is awake this fills in over a few minutes'}</div>`;
  }
  // Spread the samples we actually have across the full width, so even a fresh
  // graph draws a real line edge to edge instead of a stub at the right.
  const xAt = (i: number) => pts.length < 2 ? W / 2 : pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const yAt = (pct: number) => pad + (1 - Math.min(100, Math.max(0, pct)) / 100) * (H - 2 * pad);
  const cpuMax = info.cpuMax || 150;
  const cpu = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt((p.cpuPct / cpuMax) * 100).toFixed(1)}`).join(' ');
  const ram = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.memLimit ? (p.memBytes / p.memLimit) * 100 : 0).toFixed(1)}`).join(' ');
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${pad}" y1="${yAt(v).toFixed(1)}" x2="${W - pad}" y2="${yAt(v).toFixed(1)}" stroke="rgba(180,168,224,0.16)" stroke-width="1"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="ov-graph-svg" aria-hidden="true">${grid}` +
    `<polyline points="${ram}" fill="none" stroke="#ffb340" stroke-width="2" stroke-linejoin="round"/>` +
    `<polyline points="${cpu}" fill="none" stroke="#35d3b0" stroke-width="2" stroke-linejoin="round"/></svg>`;
}

function buildGraph(serverId: string): HTMLElement {
  const plot = el('div', { class: 'ov-graph-plot' }, el('div', { class: 'ov-graph-empty t-mute sh' }, 'loading…'));
  const legend = el('span', { class: 'ov-legend' },
    el('span', { class: 'ov-leg-item' }, el('span', { class: 'ov-leg-dot cpu' }), 'CPU'),
    el('span', { class: 'ov-leg-item' }, el('span', { class: 'ov-leg-dot ram' }), 'RAM'),
  );
  const node = el('div', { class: 'entry ov-graph' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Performance'), legend),
    el('div', { class: 'ov-graph-body' }, plot),
  );
  async function refresh(): Promise<void> {
    let info: MetricsInfo; try { info = await api.metrics(serverId); } catch { return; }
    plot.innerHTML = drawGraph(info);
  }
  const t = window.setInterval(refresh, 15000);
  onDispose(() => window.clearInterval(t));
  void refresh();
  return node;
}

function buildActivity(serverId: string): HTMLElement {
  const list = el('div', { class: 'act-list' }, el('div', { class: 'act-empty t-mute sh' }, 'loading…'));
  const node = el('div', { class: 'entry ov-act' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Recent activity'), el('span', { class: 'k t-mute' }, 'newest first')),
    el('div', { class: 'act-wrap' }, list),
  );
  async function refresh(): Promise<void> {
    let ev; try { ev = await api.events(serverId); } catch { return; }
    clear(list);
    if (!ev.events.length) { list.append(el('div', { class: 'act-empty t-mute sh' }, 'Nothing yet — power, backups and schedules show here.')); return; }
    ev.events.forEach((e) => list.append(el('div', { class: 'act-row' },
      el('span', { class: `act-ic act-${e.kind}` }, eventGlyph(e.kind)),
      el('div', { class: 'act-main' }, el('div', { class: 'act-detail' }, e.detail), el('div', { class: 'act-when t-mute sh' }, ago(e.at))),
    )));
  }
  const t = window.setInterval(refresh, 12000);
  onDispose(() => window.clearInterval(t));
  void refresh();
  return node;
}

// ---- overview pane
interface OverviewRefs {
  cpuV: HTMLElement; cpuBar: HTMLElement; ramV: HTMLElement; ramBar: HTMLElement; ramWrap: HTMLElement;
  plV: HTMLElement; plBar: HTMLElement; upV: HTMLElement; grid: HTMLElement; gridCount: HTMLElement;
}

// A short "1d 3h" / "12m" uptime from an ISO start time.
function uptimeStr(startedAt: string | null): string {
  if (!startedAt) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function factRow(k: string, v: string): HTMLElement {
  return el('div', { class: 'fact' }, el('span', { class: 'fact-k' }, k), el('span', { class: 'fact-v' }, v));
}

function meterTile(key: string, valueEl: HTMLElement, bar?: HTMLElement): HTMLElement {
  return el('div', { class: 'entry meter' }, el('div', { class: 'k' }, key), valueEl, bar ?? el('div', { class: 'bar' }, el('i', { style: 'width:0' })));
}

function overviewPane(summary: ServerSummary): { node: HTMLElement; refs: OverviewRefs } {
  // Connection — the one thing every visitor came for, given its own panel.
  const conn = el('div', { class: 'entry pad ov-conn' },
    el('div', { class: 'label mb' }, 'Join address'),
    el('div', { class: 'mc-motd', html: motdToHtml(summary.motd) }),
    renderAddress(summary, false),
  );

  // Facts — the static truth about this server, read at a glance.
  const facts = el('div', { class: 'entry pad ov-facts' },
    el('div', { class: 'label mb' }, 'This server'),
    factRow('Software', `${summary.softwareLabel} · ${summary.kind}`),
    factRow('Version', `Minecraft ${summary.version}`),
    factRow('Memory', `${summary.ramMB / 1024} GB`),
    factRow('Max players', String(summary.maxPlayers)),
    factRow('Created', new Date(summary.createdAt).toLocaleDateString()),
  );

  const cpuV = el('span', { class: 'v' }, '—'); const cpuBar = el('i', {});
  const ramV = el('span', { class: 'v' }, '—'); const ramBar = el('i', {}); const ramWrap = el('div', { class: 'bar' }, ramBar);
  const plV = el('span', { class: 'v' }, '—'); const plBar = el('i', { style: 'width:0' });
  const upV = el('span', { class: 'v' }, '—');
  const meters = el('div', { class: 'meters meters-4' },
    meterTile('CPU', cpuV, el('div', { class: 'bar' }, cpuBar)),
    meterTile('Memory', ramV, ramWrap),
    meterTile('Players', plV, el('div', { class: 'bar' }, plBar)),
    meterTile('Uptime', upV),
  );

  const gridCount = el('span', { class: 'k t-mute' }, '0 online');
  const grid = el('div', { class: 'players-grid' }, el('span', { class: 't-mute sh' }, 'nobody online'));
  const players = el('div', { class: 'entry ov-players' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Online players'), gridCount),
    el('div', { class: 'pad' }, grid),
  );

  const node = el('div', { class: 'ov' },
    el('div', { class: 'ov-top' }, conn, facts),
    meters,
    buildGraph(summary.id),
    el('div', { class: 'ov-split' }, players, buildActivity(summary.id)),
  );
  return { node, refs: { cpuV, cpuBar, ramV, ramBar, ramWrap, plV, plBar, upV, grid, gridCount } };
}

function updateOverview(r: OverviewRefs, d: ServerDetail): void {
  if (d.state.running && d.stats) {
    const alloc = (meta?.plan.cpus ?? 1.5) * 100;
    r.cpuV.textContent = Math.round(d.stats.cpuPct) + '%';
    r.cpuBar.style.width = Math.min(100, (d.stats.cpuPct / alloc) * 100) + '%';
    const pct = d.stats.memLimit ? (d.stats.memBytes / d.stats.memLimit) * 100 : 0;
    r.ramV.textContent = fmtBytes(d.stats.memBytes) + ' / ' + fmtBytes(d.stats.memLimit);
    r.ramBar.style.width = Math.min(100, pct) + '%';
    r.ramWrap.className = 'bar' + (pct > 92 ? ' crit' : pct > 80 ? ' warn' : '');
  } else {
    r.cpuV.textContent = '—'; r.cpuBar.style.width = '0'; r.ramV.textContent = 'asleep'; r.ramBar.style.width = '0';
  }
  const online = d.players?.online ?? 0;
  const max = d.players?.max ?? summaryMax(d);
  r.plV.textContent = `${online} / ${max}`;
  r.plBar.style.width = (max ? Math.min(100, (online / max) * 100) : 0) + '%';
  r.upV.textContent = d.state.running ? uptimeStr(d.state.startedAt) : 'asleep';
  r.gridCount.textContent = d.state.running ? `${online} online` : 'asleep';
  clear(r.grid);
  if (d.players && d.players.names.length) {
    d.players.names.forEach((n) => r.grid.append(el('span', { class: 'player-chip entry' }, avatar(n, 20), n)));
  } else {
    r.grid.append(el('span', { class: 't-mute sh' }, d.state.running ? 'nobody online' : `asleep · last active ${ago(d.lastActive)}`));
  }
}

function summaryMax(d: ServerDetail): number { return d.maxPlayers ?? 20; }

// ---- live console (its scrollback survives leaving and returning to the page)
function buildConsole(serverId: string): { node: HTMLElement; connect: () => void; drop: () => void } {
  let buf = consoleBuf.get(serverId);
  if (!buf) { buf = []; consoleBuf.set(serverId, buf); }
  const scroll = buf;
  const out = el('div', { class: 'console-out mono' });
  const cmd = el('input', { class: 'input', placeholder: 'type a command, e.g. list', autocomplete: 'off' }) as HTMLInputElement;

  function paint(text: string, cls: string): void {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.append(el('div', { class: cls }, text));
    while (out.childElementCount > 400) out.firstChild && out.removeChild(out.firstChild);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }
  function pushLine(text: string, cls = 'l-info', store = true): void {
    if (store) { scroll.push({ cls, text }); while (scroll.length > 400) scroll.shift(); }
    paint(text, cls);
  }

  // replay what we already saw this session
  scroll.forEach((l) => paint(l.text, l.cls));
  if (!scroll.length) pushLine('[endhost] connecting to your server…', 'l-sys', false);

  async function runCmd(c: string): Promise<void> {
    c = c.trim(); if (!c) return;
    pushLine(`> ${c}`, 'l-you');
    try { const r = await api.command(serverId, c); if (r.output) r.output.split('\n').forEach((l) => pushLine(l, 'l-info')); }
    catch (err) { pushLine(fail(err), err instanceof ApiError && err.status === 425 ? 'l-warn' : 'l-err'); }
  }

  const form = el('form', { class: 'console-form',
    onsubmit: (e: Event) => { e.preventDefault(); const c = cmd.value.trim(); if (!c) return; cmd.value = ''; void runCmd(c); },
  }, el('span', { class: 'prompt' }, '>'), cmd, el('button', { class: 'btn btn-sm', type: 'submit' }, 'Run'));

  // One-tap common commands — each runs the real thing over RCON, same as typing it.
  const quicks: [string, string][] = [['List', 'list'], ['Save', 'save-all'], ['Day', 'time set day'], ['Clear weather', 'weather clear'], ['Reload perms', 'reload confirm']];
  const quick = el('div', { class: 'console-quick' }, el('span', { class: 'cq-label' }, 'Quick:'),
    ...quicks.map(([label, c]) => el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => void runCmd(c) }, label)));

  const node = el('div', { class: 'entry console' },
    el('div', { class: 'console-head' }, el('span', { class: 'k' }, 'Console'), el('span', { class: 'k t-mute' }, 'live log · RCON')),
    out, quick, form,
  );

  let ws: WebSocket | null = null;
  function connect(): void {
    if (ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/servers/${serverId}/console`);
    ws.onmessage = (e) => {
      String(e.data).split('\n').forEach((line) => {
        if (!line) return;
        let cls = 'l-info';
        if (/\bWARN\b/.test(line)) cls = 'l-warn';
        if (/ERROR|FATAL|Exception/.test(line)) cls = 'l-err';
        if (/joined the game|left the game/.test(line)) cls = 'l-you';
        if (line.startsWith('[endhost]')) cls = 'l-sys';
        pushLine(line, cls);
      });
    };
    ws.onclose = () => { ws = null; };
    ws.onerror = () => { ws?.close(); };
  }
  function drop(): void { ws?.close(); ws = null; }
  onDispose(drop);
  return { node, connect, drop };
}

// ---- network pane: the endhost address, a custom domain, and how to hand it out
function networkPane(summary: ServerSummary): HTMLElement {
  const addr = el('div', { class: 'entry pad' },
    el('div', { class: 'label mb' }, 'Endhost address'),
    el('p', { class: 'set-lead t-mute sh' }, summary.subdomain
      ? 'The whole address your friends type — no port needed. Rename the subdomain to anything free.'
      : 'The direct address for your server. Connect on a non-proxied host.'),
    renderAddress(summary, true, false),
  );
  const help = el('div', { class: 'entry pad' },
    el('div', { class: 'label mb' }, 'Handing it out'),
    el('p', { class: 'set-lead t-mute sh', style: 'margin:0' }, 'In Minecraft, open Multiplayer → Add Server, paste an address above, and Join. Anyone with it can connect while the server is awake; if it is asleep, the first join wakes it and they reconnect after ~30 seconds.'),
  );
  return el('div', { class: 'ov' }, addr, renderDomain(summary), help);
}

// ---- custom domain: point your own name here, verified against live DNS
function copyField(label: string, value: string): HTMLElement {
  return el('div', { class: 'dns-field' },
    el('span', { class: 'dns-k' }, label),
    el('code', { class: 'dns-v' }, value),
    el('button', {
      class: 'btn btn-ghost btn-sm dns-copy', title: 'Copy',
      onclick: async (e: Event) => {
        try { await navigator.clipboard.writeText(value); const b = e.currentTarget as HTMLElement; const t = b.textContent; b.textContent = '✓'; setTimeout(() => (b.textContent = t), 1000); }
        catch { toast('Copy failed', 'err'); }
      },
    }, 'copy'),
  );
}

function renderDomain(summary: ServerSummary): HTMLElement {
  const body = el('div', { class: 'dom-body' }, el('div', { class: 'loading blink', style: 'padding:14px 16px' }, 'Loading '));
  const card = el('div', { class: 'entry dom' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Custom domain'), el('span', { class: 'k t-mute' }, 'point your own name here')),
    body,
  );

  function setForm(current: string): HTMLElement {
    const input = el('input', { class: 'input', placeholder: 'mc.yourname.com', value: current, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    const save = el('button', { class: 'btn btn-portal btn-sm', type: 'submit' }, current ? 'Update domain' : 'Use this domain') as HTMLButtonElement;
    const msg = el('div', { class: 'fm-msg' });
    return el('form', { class: 'dom-form',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const d = input.value.trim().toLowerCase();
        if (!d) return;
        msg.textContent = ''; msg.className = 'fm-msg'; save.classList.add('is-disabled'); save.textContent = 'Saving…';
        try { await api.domainSet(summary.id, d); summary.customDomain = d; toast('Domain saved — now add the DNS records.'); await load(); }
        catch (err) { msg.className = 'fm-msg err'; msg.textContent = fail(err); save.classList.remove('is-disabled'); save.textContent = current ? 'Update domain' : 'Use this domain'; }
      },
    }, el('div', { class: 'dom-form-row' }, input, save), msg);
  }

  function recordsBlock(info: DomainInfo): HTMLElement {
    const rec = info.records!;
    return el('div', { class: 'dns-records' },
      el('div', { class: 'dns-rec' },
        el('div', { class: 'dns-rec-head' }, el('span', { class: 'dns-badge' }, 'A'), el('span', { class: 'dns-rec-note t-mute' }, 'points the name at the host')),
        copyField('Name', rec.a.name),
        copyField('IPv4 address', rec.a.value),
        el('div', { class: 'dns-hint t-mute sh' }, 'Set the proxy status to DNS only (grey cloud) — Minecraft traffic cannot go through Cloudflare’s proxy.'),
      ),
      el('div', { class: 'dns-rec' },
        el('div', { class: 'dns-rec-head' }, el('span', { class: 'dns-badge' }, 'SRV'), el('span', { class: 'dns-rec-note t-mute' }, 'optional — lets players skip the port')),
        copyField('Name', rec.srv.name),
        copyField('Target', rec.srv.target),
        copyField('Port', String(rec.srv.port)),
        el('div', { class: 'dns-hint t-mute sh' }, `Priority ${rec.srv.priority}, weight ${rec.srv.weight}. Without it, players join with ${info.domain}:${info.port}.`),
      ),
    );
  }

  function statusBlock(): { node: HTMLElement; check: HTMLButtonElement } {
    const out = el('div', { class: 'dom-status' });
    const check = el('button', { class: 'btn btn-sm', onclick: async () => {
      check.classList.add('is-disabled'); check.textContent = 'Checking…'; clear(out);
      try {
        const r: DomainCheck = await api.domainCheck(summary.id);
        out.append(statusLine('A record', r.aOk, r.aOk ? `resolves to ${r.expectedIp}` : (r.aRecords.length ? `points at ${r.aRecords.join(', ')} — not us yet` : 'not visible yet')));
        out.append(statusLine('SRV record', r.srvOk, r.srvOk ? `port ${r.port}, no “:port” needed` : (r.srv ? `found, but port ${r.srv.port} ≠ ${r.port}` : `none — players use ${summary.customDomain}:${r.port}`)));
        out.append(el('div', { class: `dom-verdict ${r.ready ? 'ok' : 'wait'}` }, r.ready
          ? (r.srvOk ? `Live — players can join at ${summary.customDomain}` : `Live — players join at ${summary.customDomain}:${r.port}`)
          : 'Not resolving here yet. New records can take a few minutes to spread.'));
      } catch (e) { out.append(el('div', { class: 'fm-msg err' }, fail(e))); }
      finally { check.classList.remove('is-disabled'); check.textContent = 'Check DNS'; }
    } }, 'Check DNS') as HTMLButtonElement;
    return { node: out, check };
  }
  function statusLine(k: string, ok: boolean, detail: string): HTMLElement {
    return el('div', { class: 'dom-stat' },
      el('span', { class: `dot ${ok ? 'on' : 'busy'}` }),
      el('span', { class: 'dom-stat-k' }, k),
      el('span', { class: 'dom-stat-v t-mute' }, detail),
    );
  }

  async function load(): Promise<void> {
    let info: DomainInfo;
    try { info = await api.domain(summary.id); } catch (e) { clear(body); body.append(el('div', { class: 'fm-msg err' }, fail(e))); return; }
    clear(body);
    if (!info.domain) {
      body.append(
        el('p', { class: 'set-lead t-mute sh dom-lead' }, `Bring a domain you already own — like ${'mc.yourname.com'} — and players join by that name instead of your ${'example.invalid'} address. You add two DNS records at your registrar; nothing changes here.`),
        setForm(''),
      );
      return;
    }
    const remove = el('button', { class: 'btn btn-ghost btn-sm fm-del', onclick: async () => {
      if (!window.confirm(`Stop using ${info.domain}? Players will fall back to your example.invalid address. Your DNS records stay as they are — remove them at your registrar if you like.`)) return;
      try { await api.domainClear(summary.id); summary.customDomain = null; toast('Custom domain removed.'); await load(); } catch (e) { toast(fail(e), 'err'); }
    } }, 'Remove');
    const status = statusBlock();
    body.append(
      el('div', { class: 'dom-current' },
        el('div', {},
          el('div', { class: 'label' }, 'Your domain'),
          el('div', { class: 'dom-name' }, info.domain),
        ),
        el('div', { class: 'dom-current-actions' }, status.check, remove),
      ),
      el('p', { class: 'set-lead t-mute sh dom-lead' }, 'Create these two records at whoever runs your DNS, then Check DNS to confirm they are live:'),
      recordsBlock(info),
      status.node,
      el('details', { class: 'dom-change' }, el('summary', {}, 'Use a different domain'), setForm(info.domain)),
    );
  }

  void load();
  return card;
}

// ---- settings pane: read-only facts + the danger zone
function settingsPane(summary: ServerSummary): HTMLElement {
  const info = el('div', { class: 'entry' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Server details'), el('span', { class: 'k t-mute' }, 'read-only')),
    el('div', { class: 'kv-grid' },
      kv('Name', summary.name),
      kv('Server id', summary.id, true),
      kv('Software', `${summary.softwareLabel} (${summary.kind})`),
      kv('Minecraft version', summary.version),
      kv('Plan', `${summary.plan} · ${summary.ramMB / 1024} GB RAM`),
      kv('Created', new Date(summary.createdAt).toLocaleString()),
    ),
  );

  const del = el('button', { class: 'btn btn-danger', onclick: async () => {
    if (!window.confirm(`Delete ${summary.name} and its world for good? This cannot be undone.`)) return;
    try {
      await api.remove(summary.id);
      detailCache.delete(summary.id); consoleBuf.delete(summary.id);
      toast('Server deleted.');
      await loadServers();
      go(state.servers.length ? serverHash(state.servers[0].id, 'overview') : '#/new');
    } catch (e) { toast(fail(e), 'err'); }
  } }, 'Delete this server');

  const danger = el('div', { class: 'entry pad danger-zone' },
    el('div', { class: 'k sh mb', style: 'color:var(--mc-red)' }, 'Danger zone'),
    el('p', { class: 'set-lead t-mute sh' }, 'Deleting removes the container and its world volume permanently.'),
    del,
  );

  return el('div', { class: 'ov' }, info, lobbyStartCard(summary), danger);
}

// Let players start this server from inside the lobby (its selector tile / `/start`). Off by
// default; a live-slot limit still applies, so it only starts if a slot is free.
function lobbyStartCard(summary: ServerSummary): HTMLElement {
  const status = el('div', { class: 'proxy-status' });
  const btnWrap = el('div', { class: 'proxy-btns' });
  let on = summary.lobbyStartable;

  function render(): void {
    clear(status); clear(btnWrap);
    status.append(el('span', { class: 'net-pill ' + (on ? 'on' : 'off') },
      el('span', { class: 'dot ' + (on ? 'on' : 'off') }), on ? 'Players can start it from the lobby' : 'Panel only'));
    btnWrap.append(el('button', { class: on ? 'btn btn-ghost btn-sm' : 'btn btn-portal btn-sm', onclick: async (e: Event) => {
      const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
      try {
        const r = await api.setLobbyStartable(summary.id, !on);
        on = r.lobbyStartable; summary.lobbyStartable = on;
        toast(on ? 'Players can now start this from the lobby.' : 'Lobby start turned off.');
        render();
      } catch (err) { toast(fail(err), 'err'); b.classList.remove('is-disabled'); }
    } }, on ? 'Turn off' : 'Allow lobby start'));
  }
  render();

  return el('div', { class: 'entry pad' },
    el('div', { class: 'k sh mb' }, 'Start from the lobby'),
    el('p', { class: 'set-lead t-mute sh' }, 'Let players start this server straight from the lobby’s selector or with /start. The same live-slot limit applies — it only starts when a slot is free.'),
    status, btnWrap,
  );
}

function kv(k: string, v: string, mono = false): HTMLElement {
  return el('div', { class: 'kv' }, el('span', { class: 'kv-k' }, k), el('span', { class: `kv-v${mono ? ' mono' : ''}` }, v));
}

// ------------------------------------------------------------------ players
// A live roster: who is on now (RCON), plus the server's own operator, whitelist
// and ban lists (its json files). Every button is a real console command, which
// the server only answers while awake — asleep, the lists show but actions wait.
function renderPlayers(serverId: string): HTMLElement {
  const banner = el('div', { class: 'pl-banner' });
  const groups = el('div', { class: 'pl-groups' }, el('div', { class: 'loading blink', style: 'padding:12px 14px' }, 'Loading '));

  async function doAction(action: PlayerAction, name = ''): Promise<void> {
    try { const r = await api.playerAction(serverId, action, name); const out = (r.output || '').trim(); if (out) toast(out.slice(0, 140)); await load(); }
    catch (e) { toast(fail(e), 'err'); }
  }

  function miniBtn(label: string, action: PlayerAction, name: string, danger = false, confirmMsg?: string): HTMLElement {
    return el('button', { class: `btn btn-ghost btn-sm${danger ? ' fm-del' : ''}`, onclick: async (e: Event) => {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      (e.currentTarget as HTMLElement).classList.add('is-disabled');
      await doAction(action, name);
    } }, label);
  }

  function chip(name: string, actions: HTMLElement[]): HTMLElement {
    return el('div', { class: 'pl-chip entry' },
      avatar(name, 22), el('span', { class: 'pl-name' }, name),
      actions.length ? el('span', { class: 'pl-acts' }, ...actions) : '',
    );
  }

  function addForm(action: PlayerAction, placeholder: string): HTMLElement {
    const input = el('input', { class: 'input pl-input', placeholder, maxlength: '16', autocomplete: 'off' }) as HTMLInputElement;
    return el('form', { class: 'pl-add', onsubmit: async (e: Event) => { e.preventDefault(); const n = input.value.trim(); if (!n) return; input.value = ''; await doAction(action, n); } },
      input, el('button', { class: 'btn btn-sm btn-portal', type: 'submit' }, 'Add'));
  }

  function group(title: string, meta: string, ...body: (Node | string | false)[]): HTMLElement {
    return el('div', { class: 'entry pl-group' },
      el('div', { class: 'card-head' }, el('span', { class: 'k' }, title), el('span', { class: 'k t-mute' }, meta)),
      el('div', { class: 'pl-group-body' }, ...body),
    );
  }
  const chips = (arr: HTMLElement[]): HTMLElement => el('div', { class: 'pl-chips' }, ...arr);
  const emptyLine = (t: string): HTMLElement => el('div', { class: 'pl-empty' }, t);

  function render(r: Roster): void {
    clear(banner);
    if (!r.running) banner.append(el('div', { class: 'entry pad pl-asleep' }, '☾ This server is asleep — start it to add, remove or kick players. The lists below are its saved records.'));

    const online = r.running && r.online.length
      ? chips(r.online.map((n) => chip(n, [miniBtn('Op', 'op', n), miniBtn('Kick', 'kick', n), miniBtn('Ban', 'ban', n, true, `Ban ${n} from this server?`)])))
      : emptyLine(r.running ? 'Nobody is online right now.' : 'Start the server to see who is connected.');

    const ops = r.ops.length ? chips(r.ops.map((n) => chip(n, r.running ? [miniBtn('De-op', 'deop', n)] : []))) : emptyLine('No operators yet.');
    const wl = r.whitelist.names.length ? chips(r.whitelist.names.map((n) => chip(n, r.running ? [miniBtn('Remove', 'wl-remove', n)] : []))) : emptyLine('Nobody is whitelisted.');
    const banned = r.banned.length ? chips(r.banned.map((n) => chip(n, r.running ? [miniBtn('Pardon', 'pardon', n)] : []))) : emptyLine('No one is banned.');

    const wlToggle = el('button', {
      class: `btn btn-sm ${r.whitelist.enabled ? 'btn-portal' : 'btn-ghost'}`,
      title: r.whitelist.enabled ? 'Whitelist is enforced — only listed names can join' : 'Whitelist is off — anyone can join',
      onclick: async (e: Event) => { (e.currentTarget as HTMLElement).classList.add('is-disabled'); await doAction(r.whitelist.enabled ? 'wl-off' : 'wl-on'); },
    }, r.whitelist.enabled ? '● Whitelist on' : '○ Whitelist off');

    const wlHead = el('div', { class: 'card-head' },
      el('span', { class: 'k' }, 'Whitelist'),
      el('span', { class: 'pl-wl-head' }, el('span', { class: 'k t-mute' }, `${r.whitelist.names.length}`), r.running ? wlToggle : el('span', { class: 'k t-mute' }, r.whitelist.enabled ? 'on' : 'off')),
    );
    const wlGroup = el('div', { class: 'entry pl-group' }, wlHead,
      el('div', { class: 'pl-group-body' }, wl, r.running ? addForm('wl-add', 'name to whitelist') : false));

    clear(groups);
    groups.append(
      group('Online now', r.running ? `${r.online.length} / ${r.max}` : 'asleep', online),
      group('Operators', String(r.ops.length), ops, r.running ? addForm('op', 'name to op') : false),
      wlGroup,
      group('Banned', String(r.banned.length), banned, r.running ? addForm('ban', 'name to ban') : false),
    );
  }

  async function load(): Promise<void> {
    let r: Roster;
    try { r = await api.roster(serverId); } catch (e) { clear(groups); groups.append(el('div', { class: 'pl-empty' }, fail(e))); return; }
    render(r);
  }

  void load();
  const timer = window.setInterval(load, 5000);
  onDispose(() => window.clearInterval(timer));

  return el('div', { class: 'ov pl' }, banner, groups);
}

// ------------------------------------------------------------------ world
// Difficulty and gamerules, over RCON. They save into level.dat, so a change
// holds across restarts. Reading needs the server awake; asleep, the page shows
// the controls but says to start it first — no pretending a change stuck.
function renderWorld(serverId: string): HTMLElement {
  const body = el('div', { class: 'wl-body' }, el('div', { class: 'loading blink', style: 'padding:14px 16px' }, 'Loading '));
  const sub = (t: string): HTMLElement => el('div', { class: 'wl-sub' }, t);

  function difficultyRow(info: WorldInfo, current: string | null): HTMLElement {
    const row = el('div', { class: 'wl-diffs' });
    info.difficulties.forEach((d) => {
      const b = el('button', { class: 'btn btn-sm wl-diff' + (d === current ? ' active' : ''), onclick: async () => {
        if (b.classList.contains('active')) return;
        row.querySelectorAll('.wl-diff').forEach((x) => x.classList.add('is-disabled'));
        try { await api.worldDifficulty(serverId, d); row.querySelectorAll('.wl-diff').forEach((x) => x.classList.remove('active')); b.classList.add('active'); toast(`Difficulty set to ${d}.`); }
        catch (e) { toast(fail(e), 'err'); }
        finally { row.querySelectorAll('.wl-diff').forEach((x) => x.classList.remove('is-disabled')); }
      } }, d[0].toUpperCase() + d.slice(1));
      row.append(b);
    });
    return row;
  }

  function ruleRow(def: GameRuleDef, on: boolean, live: boolean): HTMLElement {
    const sw = el('button', { class: 'wl-switch' + (on ? ' on' : '') + (live ? '' : ' is-disabled'), role: 'switch', 'aria-checked': on ? 'true' : 'false', title: def.help }, el('span', { class: 'wl-knob' }));
    let val = on;
    if (live) sw.addEventListener('click', async () => {
      sw.classList.add('is-disabled');
      try { const r = await api.worldRule(serverId, def.key, !val); val = r.value; sw.classList.toggle('on', val); sw.setAttribute('aria-checked', val ? 'true' : 'false'); }
      catch (e) { toast(fail(e), 'err'); }
      finally { sw.classList.remove('is-disabled'); }
    });
    return el('div', { class: 'wl-rule' },
      el('div', { class: 'wl-rule-main' }, el('div', { class: 'wl-rule-label' }, def.label), el('div', { class: 'wl-rule-help t-mute' }, def.help)),
      sw,
    );
  }

  function quickRow(): HTMLElement {
    const mk = (label: string, action: string) => el('button', { class: 'btn btn-ghost btn-sm', onclick: async (e: Event) => {
      const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
      try { await api.worldQuick(serverId, action); toast(`Done — ${label.toLowerCase()}.`); } catch (err) { toast(fail(err), 'err'); }
      finally { b.classList.remove('is-disabled'); }
    } }, label);
    return el('div', { class: 'wl-quick' }, mk('Set day', 'time-day'), mk('Set night', 'time-night'), mk('Clear weather', 'weather-clear'), mk('Start rain', 'weather-rain'));
  }

  async function load(): Promise<void> {
    let info: WorldInfo;
    try { info = await api.world(serverId); } catch (e) { clear(body); body.append(el('div', { class: 'fm-msg err' }, fail(e))); return; }
    clear(body);
    const s = info.settings;
    if (!info.running || !s) {
      body.append(
        el('div', { class: 'pl-asleep wl-asleep' }, '☾ This server is asleep — start it to load and change its world settings.'),
        el('div', { class: 'wl-section' }, sub('Gamerules'),
          el('div', { class: 'wl-rules' }, ...info.rules.map((r) => ruleRow(r, false, false)))),
      );
      return;
    }
    body.append(
      el('div', { class: 'wl-section' }, sub('Difficulty'), difficultyRow(info, s.difficulty)),
      el('div', { class: 'wl-section' }, sub('Gamerules'),
        el('div', { class: 'wl-rules' }, ...info.rules.map((r) => ruleRow(r, !!s.rules[r.key], true)))),
      el('div', { class: 'wl-section' }, sub('Quick actions'), quickRow()),
    );
  }

  void load();
  return el('div', { class: 'entry wl' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'World settings'), el('span', { class: 'k t-mute' }, 'saved in the world')),
    body,
  );
}

// ------------------------------------------------------------------ schedule
// Automated tasks. Each is a real intent the server-side engine fires when it comes
// due — a nightly restart, a scheduled backup, a timed command — recording what
// actually happened. Here we just create, toggle, run-now and delete them.
function until(ms: number): string {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `in ${d}d ${h}h`;
  if (h) return `in ${h}h ${m}m`;
  if (m) return `in ${m}m`;
  return 'in <1m';
}
function resultClass(r: string | null): string {
  if (!r) return 't-mute';
  if (r.startsWith('ok')) return 't-green';
  if (r.startsWith('error')) return 't-red';
  return 't-gold';
}

function renderSchedule(serverId: string): HTMLElement {
  const list = el('div', { class: 'sch-list' }, el('div', { class: 'loading blink', style: 'padding:12px 14px' }, 'Loading '));
  const formHost = el('div', { class: 'sch-form-host' });
  const formMsg = el('div', { class: 'form-msg', style: 'padding:0 16px 14px' });

  async function act(fn: () => Promise<unknown>, okMsg?: string): Promise<void> {
    try { await fn(); if (okMsg) toast(okMsg); await load(); }
    catch (e) { toast(fail(e), 'err'); }
  }

  function actionLabel(id: string, actions: ScheduleActionDef[]): string {
    return actions.find((a) => a.id === id)?.label || id;
  }

  function row(s: Schedule, actions: ScheduleActionDef[]): HTMLElement {
    const toggle = el('button', {
      class: `wl-switch${s.enabled ? ' on' : ''}`, role: 'switch', 'aria-checked': s.enabled ? 'true' : 'false',
      title: s.enabled ? 'On — click to pause' : 'Paused — click to enable',
      onclick: () => act(() => api.scheduleToggle(serverId, s.id, !s.enabled)),
    }, el('span', { class: 'wl-knob' }));

    const title = s.action === 'command'
      ? el('span', { class: 'sch-title' }, actionLabel(s.action, actions), ' ', el('code', { class: 'sch-cmd' }, s.command || ''))
      : el('span', { class: 'sch-title' }, actionLabel(s.action, actions));

    const meta = el('div', { class: 'sch-meta' },
      el('span', { class: 'sch-trigger t-teal sh' }, s.trigger),
      el('span', { class: 'sch-sep' }, '·'),
      el('span', { class: 't-mute sh' }, s.enabled ? `next ${until(s.nextRun)}` : 'paused'),
      s.note ? el('span', { class: 'sch-note t-mute sh' }, `“${s.note}”`) : '',
    );
    const last = s.lastResult
      ? el('div', { class: 'sch-last' }, el('span', { class: 't-mute sh' }, `last: ${ago(s.lastRun || 0)} — `), el('span', { class: `${resultClass(s.lastResult)} sh` }, s.lastResult))
      : el('div', { class: 'sch-last t-mute sh' }, 'has not run yet');

    return el('div', { class: 'sch-row entry' + (s.enabled ? '' : ' sch-off') },
      toggle,
      el('div', { class: 'sch-body' }, title, meta, last),
      el('div', { class: 'sch-actions' },
        el('button', { class: 'btn btn-ghost btn-sm', title: 'Run this task once, right now', onclick: (e: Event) => { (e.currentTarget as HTMLElement).classList.add('is-disabled'); act(() => api.scheduleRun(serverId, s.id), 'Ran once.'); } }, 'Run now'),
        el('button', { class: 'btn btn-ghost btn-sm fm-del', onclick: () => { if (window.confirm('Delete this scheduled task?')) act(() => api.scheduleDelete(serverId, s.id), 'Deleted.'); } }, 'Delete'),
      ),
    );
  }

  function buildForm(info: SchedulesInfo): HTMLElement {
    const full = info.schedules.length >= info.max;
    const actionSel = el('select', { class: 'input' }, ...info.actions.map((a) => el('option', { value: a.id }, a.label))) as HTMLSelectElement;
    const actionDesc = el('div', { class: 'field-note t-mute sh' }, info.actions[0]?.desc || '');
    const kindSel = el('select', { class: 'input' }, el('option', { value: 'interval' }, 'Every N hours'), el('option', { value: 'daily' }, 'Daily at a time')) as HTMLSelectElement;
    const hoursInput = el('input', { class: 'input', type: 'number', min: '1', max: '168', value: '6' }) as HTMLInputElement;
    const timeInput = el('input', { class: 'input', placeholder: '04:00', maxlength: '5', value: '04:00' }) as HTMLInputElement;
    const cmdInput = el('input', { class: 'input', placeholder: 'command to run, e.g. say Restarting soon', maxlength: '200', autocomplete: 'off' }) as HTMLInputElement;
    const noteInput = el('input', { class: 'input', placeholder: 'label (optional)', maxlength: '60', autocomplete: 'off' }) as HTMLInputElement;

    const hoursField = el('label', { class: 'sch-field' }, el('span', { class: 'label' }, 'Every (hours)'), hoursInput);
    const timeField = el('label', { class: 'sch-field', style: 'display:none' }, el('span', { class: 'label' }, 'At (HH:MM)'), timeInput);
    const cmdField = el('label', { class: 'sch-field sch-field-wide', style: 'display:none' }, el('span', { class: 'label' }, 'Command'), cmdInput);

    const syncAction = () => {
      const def = info.actions.find((a) => a.id === actionSel.value);
      actionDesc.textContent = def?.desc || '';
      cmdField.style.display = def?.needsCommand ? '' : 'none';
    };
    const syncKind = () => {
      const daily = kindSel.value === 'daily';
      hoursField.style.display = daily ? 'none' : '';
      timeField.style.display = daily ? '' : 'none';
    };
    actionSel.addEventListener('change', syncAction);
    kindSel.addEventListener('change', syncKind);

    const submit = el('button', { class: 'btn btn-portal', type: 'submit' }, 'Add task') as HTMLButtonElement;
    if (full) { submit.classList.add('is-disabled'); }

    const form = el('form', { class: 'sch-form',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        formMsg.textContent = ''; formMsg.className = 'form-msg';
        const body: any = { action: actionSel.value, kind: kindSel.value };
        if (kindSel.value === 'daily') body.time = timeInput.value.trim();
        else body.hours = Number(hoursInput.value);
        if (info.actions.find((a) => a.id === actionSel.value)?.needsCommand) body.command = cmdInput.value.trim();
        const note = noteInput.value.trim(); if (note) body.note = note;
        submit.classList.add('is-disabled');
        try { await api.scheduleCreate(serverId, body); toast('Task scheduled.'); await load(); }
        catch (err) { formMsg.textContent = fail(err); formMsg.className = 'form-msg err'; submit.classList.remove('is-disabled'); }
      },
    },
      el('div', { class: 'sch-form-grid' },
        el('label', { class: 'sch-field' }, el('span', { class: 'label' }, 'Task'), actionSel),
        el('label', { class: 'sch-field' }, el('span', { class: 'label' }, 'When'), kindSel),
        hoursField, timeField, cmdField,
        el('label', { class: 'sch-field sch-field-wide' }, el('span', { class: 'label' }, 'Label'), noteInput),
      ),
      actionDesc,
      el('div', { class: 'sch-form-foot' }, submit, full ? el('span', { class: 'field-note t-gold sh' }, `Limit of ${info.max} reached — delete one to add another.`) : ''),
    );
    syncAction(); syncKind();
    return form;
  }

  async function load(): Promise<void> {
    let info: SchedulesInfo;
    try { info = await api.schedules(serverId); } catch (e) { clear(list); list.append(el('div', { class: 'pl-empty' }, fail(e))); return; }
    clear(formHost); formHost.append(buildForm(info));
    clear(list);
    if (!info.schedules.length) { list.append(el('div', { class: 'sch-empty t-mute sh' }, 'No tasks yet. Add one above — a nightly restart or a scheduled backup is a good start.')); return; }
    info.schedules.forEach((s) => list.append(row(s, info.actions)));
  }

  void load();
  // Keep next-run countdowns and last-result fresh.
  const timer = window.setInterval(load, 20000);
  onDispose(() => window.clearInterval(timer));

  return el('div', { class: 'ov' },
    el('div', { class: 'entry sch-new' },
      el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'New task'), el('span', { class: 'k t-mute' }, 'runs on its own')),
      formHost, formMsg,
    ),
    el('div', { class: 'entry sch-listcard' },
      el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Scheduled tasks'), el('span', { class: 'k t-mute' }, 'host time')),
      el('div', { class: 'sch-list-wrap' }, list),
    ),
  );
}

// ------------------------------------------------------------------ backups
// Real snapshots of the whole world volume. Create one, download it, restore it,
// or delete it — each a genuine tar of the server's /data, gated by the host's
// disk caps. A restore stops the server and rewrites the world in place.
function renderBackups(summary: ServerSummary): HTMLElement {
  const serverId = summary.id;
  const list = el('div', { class: 'bk-list' }, el('div', { class: 'loading blink', style: 'padding:12px 14px' }, 'Loading '));
  const note = el('input', { class: 'input bk-note', placeholder: 'label (optional) — e.g. before the big build', maxlength: '80', autocomplete: 'off' }) as HTMLInputElement;
  const createBtn = el('button', { class: 'btn btn-portal btn-sm', type: 'submit' }, 'Create backup') as HTMLButtonElement;
  const msg = el('div', { class: 'fm-msg' });
  let max = 3;

  async function load(): Promise<void> {
    try {
      const r = await api.backups(serverId);
      max = r.max;
      clear(list);
      if (!r.backups.length) { list.append(el('div', { class: 'fm-empty' }, 'No backups yet. Create one to capture the whole world as it is now.')); }
      else r.backups.forEach((b) => list.append(row(b)));
      createBtn.classList.toggle('is-disabled', r.backups.length >= max);
      createBtn.title = r.backups.length >= max ? `At the limit of ${max} backups — delete one to make room.` : '';
    } catch (e) { clear(list); list.append(el('div', { class: 'fm-msg err' }, fail(e))); }
  }

  function row(b: Backup): HTMLElement {
    const when = new Date(b.createdAt).toLocaleString();
    const restore = el('button', { class: 'btn btn-ghost btn-sm', onclick: async (e: Event) => {
      if (!window.confirm(`Restore this backup? It replaces the current world of ${summary.name} with the saved one and stops the server. This cannot be undone.`)) return;
      const btn = e.currentTarget as HTMLElement; btn.classList.add('is-disabled'); btn.textContent = 'Restoring…';
      try {
        const r = await api.backupRestore(serverId, b.id);
        toast(r.wasRunning ? 'Restored — the server was stopped; press Start to load the restored world.' : 'World restored — press Start to load it.');
        detailCache.delete(serverId);
        await load();
      } catch (err) { toast(fail(err), 'err'); btn.classList.remove('is-disabled'); btn.textContent = 'Restore'; }
    } }, 'Restore');
    const del = el('button', { class: 'btn btn-ghost btn-sm fm-del', onclick: async () => {
      if (!window.confirm('Delete this backup for good? This cannot be undone.')) return;
      try { await api.backupDelete(serverId, b.id); await load(); } catch (e) { toast(fail(e), 'err'); }
    } }, 'Delete');
    return el('div', { class: 'bk-row' },
      el('span', { class: 'bk-ic' }, '⛃'),
      el('div', { class: 'bk-main' },
        el('div', { class: 'bk-note-line' }, b.note || 'Snapshot'),
        el('div', { class: 'bk-sub t-mute' }, `${when} · ${fmtBytes(b.sizeBytes)}`),
      ),
      el('div', { class: 'bk-actions' },
        el('a', { class: 'btn btn-ghost btn-sm', href: api.backupDownloadUrl(serverId, b.id), download: '', title: 'Download this backup' }, '↓ Download'),
        restore, del,
      ),
    );
  }

  const form = el('form', { class: 'bk-create',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      msg.textContent = ''; msg.className = 'fm-msg';
      createBtn.classList.add('is-disabled'); createBtn.textContent = 'Snapshotting…';
      try {
        await api.backupCreate(serverId, note.value.trim());
        note.value = '';
        toast('Backup created.');
        await load();
      } catch (err) { msg.className = 'fm-msg err'; msg.textContent = fail(err); }
      finally { createBtn.textContent = 'Create backup'; createBtn.classList.remove('is-disabled'); }
    },
  }, note, createBtn);

  void load();

  return el('div', { class: 'entry bk' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Backups'), el('span', { class: 'k t-mute' }, `world snapshots · up to ${max}`)),
    el('p', { class: 'set-lead t-mute sh', style: 'padding:12px 16px 0' }, 'A backup captures the entire world, configs, plugins and mods as a single file. Restoring stops the server and rewrites its world with the saved one. Downloads are a standard .tar.gz you can keep anywhere.'),
    el('div', { class: 'bk-bar' }, form, msg),
    list,
  );
}

// ------------------------------------------------------------------ billing
function renderBilling(): HTMLElement {
  return el('div', { class: 'page' }, pageHead('Guthaben', 'Your credit balance and its history. Credits keep a server awake past idle; an admin tops you up until card payments land.'), renderCredits());
}

function renderCredits(): HTMLElement {
  const body = el('div', { class: 'cr-body' }, el('div', { class: 'loading blink', style: 'padding:6px 0' }, 'Loading '));
  (async () => {
    let info: CreditsInfo;
    try { info = await api.credits(); } catch (e) { clear(body); body.append(el('div', { class: 'form-msg err' }, fail(e))); return; }
    setBal(info.balance);
    clear(body);
    body.append(
      el('div', { class: 'cr-top' },
        el('div', { class: 'cr-balance' }, el('span', { class: 'cr-num' }, String(info.balance)), el('span', { class: 'cr-unit' }, 'credits')),
        el('div', { class: 'cr-note t-mute sh' }, `Always-on costs ${info.alwaysOnPerHour} credits/hour. Need more? An admin tops you up — card payments land later.`),
      ),
      ledgerList(info.ledger),
    );
  })();
  return el('div', { class: 'entry cr' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Balance'), el('span', { class: 'k t-mute' }, 'history')),
    body,
  );
}

function ledgerList(ledger: Tx[]): HTMLElement {
  if (!ledger.length) return el('div', { class: 'fm-empty' }, 'No credit movements yet.');
  const list = el('div', { class: 'cr-ledger' });
  ledger.forEach((t) => list.append(el('div', { class: 'cr-tx' },
    el('span', { class: `cr-delta ${t.delta >= 0 ? 'pos' : 'neg'}` }, `${t.delta >= 0 ? '+' : ''}${t.delta}`),
    el('span', { class: 'cr-reason' }, t.reason),
    el('span', { class: 'cr-when t-mute' }, ago(t.at)),
    el('span', { class: 'cr-after t-mute' }, `→ ${t.balanceAfter}`),
  )));
  return list;
}

// ------------------------------------------------------------------ account
function renderAccount(): HTMLElement {
  const profile = el('div', { class: 'entry' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Profile'), el('span', { class: 'k t-mute' }, me?.admin ? 'admin' : 'member')),
    el('div', { class: 'acct-line' }, el('span', { class: 'acct-k' }, 'Email'), el('span', { class: 'acct-v' }, me?.email ?? '')),
    el('div', { class: 'acct-line' }, el('span', { class: 'acct-k' }, 'Guthaben'), el('span', { class: 'acct-v' }, el('a', { class: 'crumb', href: '#/billing' }, `◈ ${me?.credits ?? 0} — view history`))),
    el('div', { class: 'acct-line' }, el('span', { class: 'acct-k' }, 'Servers'), el('span', { class: 'acct-v' }, `${me?.serverCount ?? 0} of ${me?.serverLimit ?? 1}`)),
  );

  const signout = el('div', { class: 'entry pad' },
    el('div', { class: 'k t-mute sh mb' }, 'Session'),
    el('p', { class: 'set-lead t-mute sh' }, 'Sign out of this browser. Your servers keep running.'),
    el('button', { class: 'btn btn-ghost', onclick: async () => { await api.logout().catch(() => {}); me = null; location.hash = ''; swapWhole(renderAuth()); } }, 'Sign out'),
  );

  return el('div', { class: 'page' },
    pageHead('Account', 'Your sign-in and plan. File-transfer credentials live under each server’s Access page.'),
    profile, linkMcCard(), signout,
  );
}

// Link a Minecraft account to this panel account: mint a one-time code, show the player the
// /link command to type in-game, and poll until the proxy relays the confirmation back.
function linkMcCard(): HTMLElement {
  const body = el('div', {});
  const card = el('div', { class: 'entry' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Minecraft account'), el('span', { class: 'k t-mute' }, 'in-game control')),
    body,
  );
  let poll = 0;
  onDispose(() => { if (poll) window.clearInterval(poll); });

  function render(): void {
    clear(body);
    if (me?.mcLinked) {
      body.append(
        el('p', { class: 'set-lead t-mute sh' }, 'Linked. You can start, stop and restart your own servers in-game with /start, /stop and /restart from anywhere on the network.'),
        el('div', { class: 'acct-line' }, el('span', { class: 'acct-k' }, 'Linked as'), el('span', { class: 'acct-v' }, me.mcName ?? 'your Minecraft account')),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: async (e: Event) => {
          const b = e.currentTarget as HTMLElement; b.classList.add('is-disabled');
          try { await api.unlink(); await refreshMe(); render(); toast('Minecraft account unlinked.'); }
          catch (err) { toast(fail(err), 'err'); b.classList.remove('is-disabled'); }
        } }, 'Unlink'),
      );
      return;
    }
    body.append(
      el('p', { class: 'set-lead t-mute sh' }, 'Link your Minecraft account to control your own servers in-game — /start, /stop and /restart, plus /myservers, from anywhere on the network.'),
      el('button', { class: 'btn btn-portal btn-sm', onclick: (e: Event) => void begin(e.currentTarget as HTMLElement) }, '⛓ Link my Minecraft account'),
    );
  }

  async function begin(btn: HTMLElement): Promise<void> {
    btn.classList.add('is-disabled');
    let info: { code: string; ttlSec: number; address: string };
    try { info = await api.linkCode(); }
    catch (e) { toast(fail(e), 'err'); btn.classList.remove('is-disabled'); return; }
    clear(body);
    body.append(
      el('p', { class: 'set-lead t-mute sh' }, `Join ${info.address}, then type this in chat:`),
      el('div', { class: 'link-steps' },
        el('code', { class: 'link-code' }, `/link ${info.code}`),
        el('button', { class: 'btn btn-ghost btn-xs', onclick: (e: Event) => copyText(`/link ${info.code}`, e) }, 'copy')),
      el('div', { class: 'loading blink', style: 'padding:6px 0' }, 'Waiting for you to run it in-game '),
    );
    if (poll) window.clearInterval(poll);
    let elapsed = 0;
    poll = window.setInterval(async () => {
      elapsed += 3;
      await refreshMe();
      if (me?.mcLinked) { window.clearInterval(poll); poll = 0; render(); toast('Minecraft account linked!'); return; }
      if (elapsed >= info.ttlSec) { window.clearInterval(poll); poll = 0; render(); toast('That code expired — get a fresh one.', 'err'); }
    }, 3000);
  }

  render();
  return card;
}

// ------------------------------------------------------------------- admin
function renderAdmin(section: 'accounts' | 'servers' | 'ranks'): HTMLElement {
  const nav = el('div', { class: 'sv-nav' },
    el('a', { class: 'sv-nav-item' + (section === 'accounts' ? ' active' : ''), href: '#/admin/accounts', onclick: () => sound.click() }, 'Accounts'),
    el('a', { class: 'sv-nav-item' + (section === 'servers' ? ' active' : ''), href: '#/admin/servers', onclick: () => sound.click() }, 'Servers'),
    el('a', { class: 'sv-nav-item' + (section === 'ranks' ? ' active' : ''), href: '#/admin/ranks', onclick: () => sound.click() }, 'Ranks'),
  );
  const sub = section === 'servers'
    ? 'Every server on the host — stop or delete any of them.'
    : section === 'ranks'
      ? 'Ranks, prefixes and permissions — one list, synced to the lobby and the proxy.'
      : 'Grant credits and raise server limits for any account.';
  const body = section === 'servers' ? adminServersCard() : section === 'ranks' ? adminRanksCard() : adminAccountsCard();
  return el('div', { class: 'page' }, pageHead('Admin', sub), nav, body);
}

function adminAccountsCard(): HTMLElement {
  const emailIn = el('input', { class: 'input', type: 'email', placeholder: 'account email' }) as HTMLInputElement;
  const amtIn = el('input', { class: 'input', type: 'number', placeholder: 'credits (e.g. 500)', style: 'max-width:180px' }) as HTMLInputElement;
  const msg = el('div', { class: 'form-msg' });
  const usersBox = el('div', { class: 'adm-users' });

  const limEmail = el('input', { class: 'input', type: 'email', placeholder: 'account email' }) as HTMLInputElement;
  const limIn = el('input', { class: 'input', type: 'number', min: '1', placeholder: 'server limit', style: 'max-width:180px' }) as HTMLInputElement;
  const limMsg = el('div', { class: 'form-msg' });

  async function loadUsers(): Promise<void> {
    clear(usersBox); usersBox.append(el('div', { class: 'loading blink', style: 'padding:6px 0' }, 'Loading '));
    try {
      const users = await api.adminUsers();
      clear(usersBox);
      users.forEach((u: AdminUser) => usersBox.append(el('div', { class: 'adm-row' },
        el('span', { class: 'adm-email' }, u.email, u.admin ? el('span', { class: 'admin-tag' }, 'admin') : ''),
        el('span', { class: 'adm-servers t-mute' }, `${u.servers}/${u.serverLimit} server${u.serverLimit === 1 ? '' : 's'}`),
        el('span', { class: 'adm-credits' }, `◈ ${u.credits}`),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { emailIn.value = u.email; amtIn.focus(); } }, 'Top up'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { limEmail.value = u.email; limIn.value = String(u.serverLimit); limIn.focus(); } }, 'Limit'),
      )));
    } catch (e) { clear(usersBox); usersBox.append(el('div', { class: 'form-msg err' }, fail(e))); }
  }

  const grant = el('button', { class: 'btn btn-portal btn-sm', type: 'submit' }, 'Grant credits') as HTMLButtonElement;
  const grantForm = el('form', { class: 'adm-form',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      msg.className = 'form-msg'; msg.textContent = '';
      const amount = Math.floor(Number(amtIn.value));
      if (!amount) { msg.className = 'form-msg err'; msg.textContent = 'Enter a non-zero amount.'; return; }
      grant.classList.add('is-disabled'); grant.textContent = 'Granting…';
      try {
        const r = await api.adminGrant(emailIn.value.trim(), amount);
        msg.className = 'form-msg ok'; msg.textContent = `${r.email} is now at ◈ ${r.balance}.`;
        amtIn.value = ''; await refreshMe(); buildFoot(); await loadUsers();
      } catch (err) { msg.className = 'form-msg err'; msg.textContent = fail(err); }
      finally { grant.classList.remove('is-disabled'); grant.textContent = 'Grant credits'; }
    },
  }, emailIn, amtIn, grant);

  const setLim = el('button', { class: 'btn btn-portal btn-sm', type: 'submit' }, 'Set limit') as HTMLButtonElement;
  const limForm = el('form', { class: 'adm-form',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      limMsg.className = 'form-msg'; limMsg.textContent = '';
      const n = Math.floor(Number(limIn.value));
      if (!n || n < 1) { limMsg.className = 'form-msg err'; limMsg.textContent = 'Enter a whole number of servers (1 or more).'; return; }
      setLim.classList.add('is-disabled'); setLim.textContent = 'Saving…';
      try {
        const r = await api.adminSetServerLimit(limEmail.value.trim(), n);
        limMsg.className = 'form-msg ok'; limMsg.textContent = `${r.email} may now create ${r.serverLimit} server${r.serverLimit === 1 ? '' : 's'}.`;
        await refreshMe(); buildSidebar(); await loadUsers();
      } catch (err) { limMsg.className = 'form-msg err'; limMsg.textContent = fail(err); }
      finally { setLim.classList.remove('is-disabled'); setLim.textContent = 'Set limit'; }
    },
  }, limEmail, limIn, setLim);

  void loadUsers();
  return el('div', { class: 'entry adm' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Accounts'), el('span', { class: 'k t-mute' }, 'credits · limits')),
    el('div', { class: 'adm-bar' }, el('div', { class: 'adm-form-group' }, el('span', { class: 'adm-form-label' }, 'Grant credits'), grantForm, msg)),
    el('div', { class: 'adm-bar' }, el('div', { class: 'adm-form-group' }, el('span', { class: 'adm-form-label' }, 'Server limit'), limForm, limMsg)),
    usersBox,
  );
}

function adminServersCard(): HTMLElement {
  const serversBox = el('div', { class: 'adm-users' });
  async function loadServersList(): Promise<void> {
    clear(serversBox); serversBox.append(el('div', { class: 'loading blink', style: 'padding:6px 0' }, 'Loading '));
    try {
      const servers = await api.adminServers();
      clear(serversBox);
      if (!servers.length) { serversBox.append(el('div', { class: 'fm-empty' }, 'No servers on the host.')); return; }
      servers.forEach((s: AdminServer) => {
        const dot = el('span', { class: `dot ${s.running ? 'on' : 'off'}` });
        const stopBtn = el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          try { await api.adminStopServer(s.id); await loadServersList(); } catch (e) { toast(fail(e), 'err'); }
        } }, 'Stop');
        const delBtn = el('button', { class: 'btn btn-ghost btn-sm fm-del', onclick: async () => {
          if (!window.confirm(`Delete ${s.name} (${s.owner}) and its world for good?`)) return;
          try { await api.adminDeleteServer(s.id); await loadServersList(); } catch (e) { toast(fail(e), 'err'); }
        } }, 'Delete');
        serversBox.append(el('div', { class: 'adm-row' },
          el('span', { class: 'adm-srv' }, dot, el('b', {}, s.name), s.subdomain ? el('span', { class: 't-mute' }, ` ${s.subdomain}.example.invalid`) : ''),
          el('span', { class: 'adm-owner t-mute' }, s.owner),
          el('span', { class: 'adm-sw t-mute' }, `${s.software} ${s.version}`),
          el('span', { class: 'adm-srv-actions' }, s.running ? stopBtn : '', delBtn),
        ));
      });
    } catch (e) { clear(serversBox); serversBox.append(el('div', { class: 'form-msg err' }, fail(e))); }
  }
  void loadServersList();
  return el('div', { class: 'entry adm' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'All servers'), el('span', { class: 'k t-mute' }, 'every account')),
    serversBox,
  );
}

// The rank manager: one list of ranks (prefix, colour, weight, permissions) and a player→rank
// assignment table, both written to the lobby and the proxy. Legacy & colour codes are previewed
// live the way the game renders them.
function adminRanksCard(): HTMLElement {
  const legacyHtml = (s: string) => motdToHtml(s.replace(/&/g, '§'));
  const ranksBox = el('div', { class: 'proxy-list' });
  const playersBox = el('div', { class: 'proxy-list' });
  const assignForm = el('div', {});
  let info: RanksInfo | null = null;

  async function load(): Promise<void> {
    try { info = await api.adminRanks(); }
    catch (e) { clear(ranksBox); ranksBox.append(el('div', { class: 'err-line' }, fail(e))); return; }
    renderRanks(); renderPlayers();
  }

  function renderRanks(): void {
    if (!info) return;
    clear(ranksBox);
    info.ranks.forEach((r) => {
      const del = r.id === info!.defaultId ? '' :
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => void removeRank(r) }, 'Delete');
      ranksBox.append(el('div', { class: 'proxy-row' },
        el('span', { class: 'pr-name', html: legacyHtml((r.prefix || '') + r.color + r.name) }),
        el('span', { class: 'pr-owner t-mute sh' }, `weight ${r.weight}`),
        el('span', { class: 't-mute sh' }, `${r.permissions.length} perm${r.permissions.length === 1 ? '' : 's'}`),
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => openEditor(r) }, 'Edit'),
        del,
      ));
    });
  }

  async function removeRank(r: Rank): Promise<void> {
    if (!window.confirm(`Delete the ${r.name} rank? Anyone on it falls back to the default rank.`)) return;
    try { await api.adminRankDelete(r.id); toast(`${r.name} removed.`); await load(); }
    catch (e) { toast(fail(e), 'err'); }
  }

  function openEditor(rank: Rank | null): void {
    const nodes = info?.nodes ?? [];
    const name = el('input', { class: 'input', maxlength: '24', value: rank?.name ?? '' }) as HTMLInputElement;
    const prefix = el('input', { class: 'input', maxlength: '32', value: rank?.prefix ?? '', spellcheck: 'false' }) as HTMLInputElement;
    const color = el('input', { class: 'input', maxlength: '8', value: rank?.color ?? '&7', spellcheck: 'false' }) as HTMLInputElement;
    const weight = el('input', { class: 'input', type: 'number', min: '0', max: '1000', value: String(rank?.weight ?? 10) }) as HTMLInputElement;
    const perms = el('textarea', { class: 'input', rows: '3', spellcheck: 'false' }) as HTMLTextAreaElement;
    perms.value = (rank?.permissions ?? []).join(' ');

    const preview = el('div', { style: 'padding:6px 0;min-height:20px' });
    const renderPreview = (): void => {
      clear(preview);
      preview.append(el('span', { html: legacyHtml((prefix.value || '') + (color.value || '&7') + (name.value || 'Name')) }),
        el('span', { class: 't-mute sh' }, ' Steve › hi'));
    };
    [name, prefix, color].forEach((i) => i.addEventListener('input', renderPreview));
    renderPreview();

    const chips = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' },
      ...nodes.map((n) => el('button', { class: 'btn btn-ghost btn-xs', type: 'button', onclick: () => {
        const set = new Set(perms.value.split(/[\s,]+/).filter(Boolean));
        set.add(n); perms.value = [...set].join(' ');
      } }, n)));

    const msg = el('div', { class: 'form-msg' });
    const save = el('button', { class: 'btn btn-portal btn-sm', type: 'submit' }, rank ? 'Save rank' : 'Create rank') as HTMLButtonElement;
    const form = el('form', { onsubmit: async (e: Event) => {
      e.preventDefault();
      const body: Partial<Rank> = {
        id: rank?.id, name: name.value.trim(), prefix: prefix.value, color: color.value.trim() || '&7',
        weight: Math.floor(Number(weight.value)) || 0,
        permissions: perms.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      };
      if (!body.name) { msg.className = 'form-msg err'; msg.textContent = 'A rank needs a name.'; return; }
      save.classList.add('is-disabled');
      try { await api.adminRankSave(body); toast('Rank saved.'); m.close(); await load(); }
      catch (err) { msg.className = 'form-msg err'; msg.textContent = fail(err); save.classList.remove('is-disabled'); }
    } },
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'grid-2' },
        el('div', { class: 'field' }, el('label', {}, 'Prefix (& colour codes)'), prefix),
        el('div', { class: 'field' }, el('label', {}, 'Name colour'), color),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Sort weight — higher sits at the top of tab'), weight),
      el('div', { class: 'field' }, el('label', {}, 'Preview'), preview),
      el('div', { class: 'field' }, el('label', {}, 'Permissions (space or comma separated)'), perms),
      el('div', { class: 'field' }, el('label', {}, 'Quick add a node'), chips),
      msg,
      el('div', { class: 'proxy-btns' }, save),
    );
    const m = modal(rank ? `Edit ${rank.name}` : 'New rank', form);
  }

  function renderPlayers(): void {
    if (!info) return;
    const rankName = (id: string) => info!.ranks.find((r) => r.id === id)?.name ?? id;
    clear(playersBox);
    if (!info.players.length) playersBox.append(el('div', { class: 'pl-empty' }, 'No players assigned — everyone is the default rank.'));
    info.players.forEach((p: RankAssignment) => playersBox.append(el('div', { class: 'proxy-row' },
      el('span', { class: 'pr-name' }, p.key),
      el('span', { class: 'pr-owner t-mute sh' }, rankName(p.rank)),
      el('button', { class: 'btn btn-ghost btn-xs', onclick: () => void assign(p.key, '') }, 'Remove'),
    )));

    clear(assignForm);
    const player = el('input', { class: 'input pl-input', placeholder: 'Minecraft name or UUID', maxlength: '40', autocomplete: 'off' }) as HTMLInputElement;
    const sel = el('select', { class: 'input', style: 'max-width:190px' },
      ...info.ranks.map((r) => el('option', { value: r.id }, r.name))) as HTMLSelectElement;
    assignForm.append(el('form', { class: 'pl-add', onsubmit: (e: Event) => {
      e.preventDefault(); const v = player.value.trim(); player.value = ''; if (v) void assign(v, sel.value);
    } }, player, sel, el('button', { class: 'btn btn-sm btn-portal', type: 'submit' }, 'Assign')));
  }

  async function assign(player: string, rank: string): Promise<void> {
    try { await api.adminAssignRank(player, rank); await load(); }
    catch (e) { toast(fail(e), 'err'); }
  }

  void load();

  return el('div', {},
    el('div', { class: 'entry adm' },
      el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Ranks'), el('span', { class: 'k t-mute' }, 'lobby + proxy · synced')),
      el('p', { class: 'set-lead t-mute sh' }, 'One rank list drives chat, tab and nametag prefixes, tab sorting and permissions on both the lobby and the proxy. endhost.command.<name> gates a command, endhost.build lets a rank build in the hub, endhost.staff bypasses maintenance, and * or endhost.* grant broadly.'),
      ranksBox,
      el('div', { class: 'proxy-btns', style: 'margin-top:12px' }, el('button', { class: 'btn btn-portal btn-sm', onclick: () => openEditor(null) }, '+ New rank')),
    ),
    el('div', { class: 'entry adm', style: 'margin-top:16px' },
      el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Player ranks'), el('span', { class: 'k t-mute' }, 'name or UUID → rank')),
      el('p', { class: 'set-lead t-mute sh' }, 'Assign a player by Minecraft name or UUID; anyone unlisted is the default rank. The lobby picks up a change within a couple of seconds — a player reconnects for proxy-level permissions to re-evaluate.'),
      playersBox,
      assignForm,
    ),
  );
}

// ------------------------------------------------------------------ shared
function pageHead(title: string, sub?: string): HTMLElement {
  return el('div', { class: 'page-head' }, el('h2', {}, title), sub ? el('p', { class: 't-mute sh' }, sub) : '');
}

function addrDomain(s: ServerSummary): string {
  if (s.subdomain && s.address.startsWith(s.subdomain + '.')) return s.address.slice(s.subdomain.length + 1);
  return 'example.invalid';
}

// The join address, with an optional inline subdomain rename when the router is on.
function renderAddress(summary: ServerSummary, editable = true, hint = true): HTMLElement {
  const wrap = el('div', { class: 'addr-wrap' });
  const copyBtn = () => el('button', {
    class: 'btn btn-ghost copy-btn',
    onclick: async (e: Event) => {
      try { await navigator.clipboard.writeText(summary.address); const b = e.currentTarget as HTMLElement; const t = b.textContent; b.textContent = 'copied ✓'; setTimeout(() => (b.textContent = t), 1200); }
      catch { toast('Copy failed', 'err'); }
    },
  }, 'copy');

  function show(): void {
    clear(wrap);
    const row = el('div', { class: 'addr' }, el('code', {}, summary.address), copyBtn());
    if (editable && summary.subdomain) row.append(el('button', { class: 'btn btn-ghost btn-sm', onclick: edit }, 'rename'));
    wrap.append(row);
    if (hint) wrap.append(el('div', { class: 'addr-hint t-mute sh' },
      summary.subdomain ? 'This is the whole address your friends type — no port needed.' : 'Direct address — connect on a non-proxied host.'));
  }
  function edit(): void {
    clear(wrap);
    const input = el('input', { class: 'input sub-input', value: summary.subdomain || '', maxlength: '30', autocomplete: 'off' }) as HTMLInputElement;
    const save = el('button', { class: 'btn btn-sm btn-portal' }, 'Save') as HTMLButtonElement;
    const doSave = async (): Promise<void> => {
      const v = input.value.trim().toLowerCase();
      if (!v || v === summary.subdomain) return show();
      save.classList.add('is-disabled'); save.textContent = 'Saving…';
      try {
        const r = await api.setSubdomain(summary.id, v);
        summary.subdomain = r.subdomain; summary.address = r.address;
        const item = sideList.querySelector(`.srv-item[data-srv="${summary.id}"] .srv-sub`);
        if (item) item.textContent = `${r.subdomain}.example.invalid`;
        toast(`Now reachable at ${r.address}`); show();
      }
      catch (e) { toast(fail(e), 'err'); save.classList.remove('is-disabled'); save.textContent = 'Save'; }
    };
    save.addEventListener('click', doSave);
    input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void doSave(); } if (e.key === 'Escape') show(); });
    wrap.append(el('div', { class: 'sub-edit' }, input, el('span', { class: 'sub-suffix' }, `.${addrDomain(summary)}`), save, el('button', { class: 'btn btn-sm btn-ghost', onclick: show }, 'Cancel')));
    input.focus(); input.select();
  }
  show();
  return wrap;
}

// ------------------------------------------------------------ marketplace card
function fmtCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function renderMarket(serverId: string, kind: 'plugins' | 'mods'): HTMLElement {
  const noun = kind === 'mods' ? 'mods' : 'plugins';
  const nounCap = kind === 'mods' ? 'Mods' : 'Plugins';
  const input = el('input', { class: 'input', placeholder: `search ${noun} on Modrinth…`, autocomplete: 'off' }) as HTMLInputElement;
  const grid = el('div', { class: 'mk-grid' });
  const msg = el('div', { class: 'fm-msg' });
  let busy = false;

  async function run(): Promise<void> {
    if (busy) return; busy = true;
    msg.textContent = ''; msg.className = 'fm-msg';
    clear(grid); grid.append(el('div', { class: 'loading blink', style: 'padding:12px 14px' }, 'Searching '));
    try {
      const r = await api.modSearch(serverId, input.value.trim());
      clear(grid);
      if (!r.hits.length) { grid.append(el('div', { class: 'fm-empty' }, `No ${noun} matched for Minecraft ${r.version}. Try another search.`)); return; }
      r.hits.forEach((h) => grid.append(card(h)));
    } catch (e) {
      clear(grid); msg.className = 'fm-msg err'; msg.textContent = fail(e);
    } finally { busy = false; }
  }

  function card(h: ModHit): HTMLElement {
    const icon = h.iconUrl
      ? el('img', { class: 'mk-icon', src: h.iconUrl, alt: '', loading: 'lazy', onerror: (e: Event) => { ((e.currentTarget as HTMLElement).style.visibility = 'hidden'); } })
      : el('div', { class: 'mk-icon mk-icon-none' }, nounCap[0]);
    const install = el('button', { class: 'btn btn-portal btn-sm mk-install' }, 'Install') as HTMLButtonElement;
    install.addEventListener('click', async () => {
      install.classList.add('is-disabled'); install.textContent = 'Installing…';
      try {
        const r = await api.modInstall(serverId, h.projectId);
        install.textContent = 'Installed ✓';
        toast(`Installed ${h.title} into /${r.dir} — restart the server to load it.`);
      } catch (e) {
        install.classList.remove('is-disabled'); install.textContent = 'Install';
        toast(fail(e), 'err');
      }
    });
    return el('div', { class: 'mk-card entry' },
      el('a', { class: 'mk-link', href: `https://modrinth.com/${kind === 'mods' ? 'mod' : 'plugin'}/${h.slug}`, target: '_blank', rel: 'noopener' }, icon),
      el('div', { class: 'mk-body' },
        el('div', { class: 'mk-title' }, h.title, h.author ? el('span', { class: 'mk-by' }, ` by ${h.author}`) : ''),
        el('div', { class: 'mk-desc' }, h.description),
        el('div', { class: 'mk-meta' },
          el('span', { class: 'mk-dls' }, `▼ ${fmtCount(h.downloads)}`),
          ...h.categories.map((c) => el('span', { class: 'mk-tag' }, c)),
        ),
      ),
      install,
    );
  }

  const form = el('form', { class: 'mk-search', onsubmit: (e: Event) => { e.preventDefault(); void run(); } },
    input, el('button', { class: 'btn btn-sm', type: 'submit' }, 'Search'),
  );

  void run();

  return el('div', { class: 'entry mk' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, nounCap), el('span', { class: 'k t-mute' }, 'Modrinth · one-click install')),
    el('div', { class: 'mk-bar' }, form),
    grid, msg,
  );
}

// ------------------------------------------------------------------ SFTP card
function copyRow(label: string, value: string): HTMLElement {
  return el('div', { class: 'sftp-row' },
    el('span', { class: 'sftp-k' }, label),
    el('code', { class: 'sftp-v' }, value),
    el('button', {
      class: 'btn btn-ghost btn-sm sftp-copy',
      onclick: async (e: Event) => {
        try {
          await navigator.clipboard.writeText(value);
          const b = e.currentTarget as HTMLElement; const t = b.textContent;
          b.textContent = 'copied ✓'; setTimeout(() => (b.textContent = t), 1200);
        } catch { toast('Copy failed', 'err'); }
      },
    }, 'copy'),
  );
}

function renderSftp(serverId: string): HTMLElement {
  const details = el('div', { class: 'sftp-details' }, el('div', { class: 'loading blink', style: 'padding:6px 0' }, 'Loading '));
  const pwWrap = el('div', { class: 'sftp-pw' });
  const msg = el('div', { class: 'form-msg' });

  function passwordForm(hasPassword: boolean): void {
    clear(pwWrap);
    const input = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: hasPassword ? 'new SFTP password' : 'choose an SFTP password' }) as HTMLInputElement;
    const btn = el('button', { class: 'btn btn-portal btn-sm', type: 'submit' }, hasPassword ? 'Change password' : 'Set password') as HTMLButtonElement;
    const form = el('form', { class: 'sftp-pw-form',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        msg.className = 'form-msg'; msg.textContent = '';
        const v = input.value;
        btn.classList.add('is-disabled'); btn.textContent = 'Saving…';
        try {
          await api.sftpSetPassword(v);
          input.value = '';
          msg.className = 'form-msg ok'; msg.textContent = 'SFTP password saved. Use it with the username above.';
          passwordForm(true);
        } catch (err) {
          msg.className = 'form-msg err'; msg.textContent = fail(err);
          btn.classList.remove('is-disabled'); btn.textContent = hasPassword ? 'Change password' : 'Set password';
        }
      },
    },
      el('label', { class: 'sftp-k' }, 'Password'),
      el('div', { class: 'sftp-pw-input' }, input, btn),
    );
    pwWrap.append(
      hasPassword
        ? el('div', { class: 'sftp-set' }, el('span', { class: 'dot on' }), 'A password is set — SFTP is on for your server.')
        : el('div', { class: 'sftp-unset' }, 'No SFTP password yet. Set one to turn SFTP on.'),
      form,
    );
  }

  (async () => {
    let info: SftpInfo;
    try { info = await api.sftpInfo(serverId); }
    catch (e) { clear(details); details.append(el('div', { class: 'form-msg err' }, fail(e))); return; }
    clear(details);
    if (!info.enabled) {
      details.append(el('div', { class: 't-mute sh' }, 'SFTP is currently turned off on this host.'));
      return;
    }
    details.append(copyRow('Host', info.host), copyRow('Port', String(info.port)), copyRow('Username', info.username));
    passwordForm(info.hasPassword);
  })();

  return el('div', { class: 'entry sftp' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'SFTP access'), el('span', { class: 'k t-mute' }, 'FileZilla · WinSCP · Cyberduck')),
    el('p', { class: 'sftp-lead t-mute sh' }, 'Move whole worlds, plugin folders or mod packs at once. Use protocol SFTP (not plain FTP), your server id as the username, and the password you set below.'),
    details, pwWrap, msg,
  );
}

// ------------------------------------------------------------------ file manager
function joinPath(cwd: string, name: string): string {
  const base = cwd === '/' || cwd === '' ? '' : cwd.replace(/\/+$/, '');
  return `${base}/${name}`;
}
function parentPath(cwd: string): string {
  if (cwd === '/' || cwd === '') return '/';
  const parts = cwd.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}
function fileGlyph(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jar') return 'JAR';
  if (['zip', 'gz', 'tar', 'mca', 'dat', 'nbt', 'png', 'jpg'].includes(ext)) return 'BIN';
  return 'TXT';
}

// The file manager works against any volume through this small adapter, so the same UI serves
// both a server's /data and the proxy's /server volume.
interface FileOps {
  list(path: string): Promise<DirListing>;
  read(path: string): Promise<{ path: string; content: string }>;
  write(path: string, content: string): Promise<unknown>;
  mkdir(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  del(path: string): Promise<unknown>;
  upload(path: string, data: Blob): Promise<unknown>;
  downloadUrl(path: string): string;
}
function serverFileOps(id: string): FileOps {
  return {
    list: (p) => api.filesList(id, p), read: (p) => api.fileRead(id, p),
    write: (p, c) => api.fileWrite(id, p, c), mkdir: (p) => api.fileMkdir(id, p),
    rename: (f, t) => api.fileRename(id, f, t), del: (p) => api.fileDelete(id, p),
    upload: (p, d) => api.fileUpload(id, p, d), downloadUrl: (p) => api.fileDownloadUrl(id, p),
  };
}
function proxyFileOps(): FileOps {
  return {
    list: (p) => api.proxyFilesList(p), read: (p) => api.proxyFileRead(p),
    write: (p, c) => api.proxyFileWrite(p, c), mkdir: (p) => api.proxyFileMkdir(p),
    rename: (f, t) => api.proxyFileRename(f, t), del: (p) => api.proxyFileDelete(p),
    upload: (p, d) => api.proxyFileUpload(p, d), downloadUrl: (p) => api.proxyFileDownloadUrl(p),
  };
}

function renderFiles(ops: FileOps, subtitle = 'world · configs · plugins'): HTMLElement {
  let cwd = '/';
  const crumbs = el('div', { class: 'crumbs' });
  const list = el('div', { class: 'fm-list' });
  const body = el('div', { class: 'fm-body' }, list);
  const msg = el('div', { class: 'fm-msg' });

  const upInput = el('input', {
    type: 'file', style: 'display:none',
    onchange: async () => {
      const inp = upInput as HTMLInputElement;
      const f = inp.files?.[0];
      if (!f) return;
      try { await ops.upload(joinPath(cwd, f.name), f); toast(`Uploaded ${f.name}`); await load(cwd); }
      catch (e) { toast(fail(e), 'err'); }
      inp.value = '';
    },
  }) as HTMLInputElement;

  const tools = el('div', { class: 'fm-tools' },
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => newFolder() }, '+ Folder'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { sound.click(); upInput.click(); } }, '↑ Upload'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => void load(cwd) }, '⟳'),
  );

  function setCrumbs(): void {
    clear(crumbs);
    crumbs.append(el('a', { class: 'crumb', href: '#', onclick: (e: Event) => { e.preventDefault(); void load('/'); } }, 'root'));
    if (cwd === '/' || cwd === '') return;
    let acc = '';
    cwd.replace(/^\/+/, '').split('/').forEach((p) => {
      acc = joinPath(acc || '/', p);
      const target = acc;
      crumbs.append(el('span', { class: 'crumb-sep' }, '/'), el('a', { class: 'crumb', href: '#', onclick: (e: Event) => { e.preventDefault(); void load(target); } }, p));
    });
  }

  async function load(path: string): Promise<void> {
    cwd = path || '/';
    setCrumbs();
    clear(body); body.append(list);
    clear(list); msg.textContent = ''; msg.className = 'fm-msg';
    list.append(el('div', { class: 'loading blink', style: 'padding:12px 14px' }, 'Loading '));
    try {
      const r = await ops.list(cwd);
      cwd = r.path; setCrumbs();
      clear(list);
      if (cwd !== '/') list.append(upRow());
      r.entries.forEach((en) => list.append(fileRow(en)));
      if (!r.entries.length) list.append(el('div', { class: 'fm-empty' }, 'This folder is empty.'));
    } catch (e) {
      clear(list); msg.className = 'fm-msg err'; msg.textContent = fail(e);
    }
  }

  function upRow(): HTMLElement {
    return el('div', { class: 'fm-row up', onclick: () => void load(parentPath(cwd)) },
      el('a', { class: 'fm-name', href: '#', onclick: (e: Event) => { e.preventDefault(); void load(parentPath(cwd)); } }, el('span', { class: 'fm-ic dir' }, '‹'), '..'),
    );
  }

  function fileRow(en: FileEntry): HTMLElement {
    const isDir = en.type === 'dir';
    const nameEl = el('a', {
      class: 'fm-name', href: '#',
      onclick: (e: Event) => { e.preventDefault(); if (isDir) void load(joinPath(cwd, en.name)); else void openFile(en); },
    }, el('span', { class: `fm-ic ${isDir ? 'dir' : 'file'}` }, isDir ? '' : fileGlyph(en.name)), en.name);

    const rowEl = el('div', { class: 'fm-row' });
    const actions = el('div', { class: 'fm-actions' },
      !isDir && el('a', { class: 'btn btn-ghost btn-sm', href: ops.downloadUrl(joinPath(cwd, en.name)), download: en.name, title: 'Download' }, '↓'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => startRename(en, rowEl) }, 'Rename'),
      el('button', {
        class: 'btn btn-ghost btn-sm fm-del', onclick: async () => {
          if (!window.confirm(`Delete ${en.name}${isDir ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
          try { await ops.del(joinPath(cwd, en.name)); await load(cwd); } catch (e) { toast(fail(e), 'err'); }
        },
      }, 'Delete'),
    );
    rowEl.append(nameEl, el('span', { class: 'fm-size' }, isDir ? '' : fmtBytes(en.size)), el('span', { class: 'fm-time' }, en.mtime ? ago(en.mtime) : ''), actions);
    return rowEl;
  }

  function startRename(en: FileEntry, rowEl: HTMLElement): void {
    const input = el('input', { class: 'input fm-inline', value: en.name }) as HTMLInputElement;
    const commit = async (): Promise<void> => {
      const nv = input.value.trim();
      if (!nv || nv === en.name) return void load(cwd);
      try { await ops.rename(joinPath(cwd, en.name), joinPath(cwd, nv)); await load(cwd); }
      catch (e) { toast(fail(e), 'err'); void load(cwd); }
    };
    input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } if (e.key === 'Escape') void load(cwd); });
    input.addEventListener('blur', () => void commit());
    clear(rowEl); rowEl.append(el('span', { class: 'fm-ic file' }), input);
    input.focus(); input.select();
  }

  function newFolder(): void {
    const input = el('input', { class: 'input fm-inline', placeholder: 'folder name' }) as HTMLInputElement;
    const rowEl = el('div', { class: 'fm-row' }, el('span', { class: 'fm-ic dir' }), input);
    const commit = async (): Promise<void> => {
      const nv = input.value.trim();
      if (!nv) return void load(cwd);
      try { await ops.mkdir(joinPath(cwd, nv)); await load(cwd); }
      catch (e) { toast(fail(e), 'err'); void load(cwd); }
    };
    input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } if (e.key === 'Escape') void load(cwd); });
    input.addEventListener('blur', () => void commit());
    const firstReal = list.querySelector('.fm-row:not(.up)');
    if (firstReal) list.insertBefore(rowEl, firstReal); else list.append(rowEl);
    input.focus();
  }

  async function openFile(en: FileEntry): Promise<void> {
    const path = joinPath(cwd, en.name);
    try { const r = await ops.read(path); showEditor(en.name, r.path, r.content); }
    catch (e) {
      if (e instanceof ApiError && (e.status === 415 || e.status === 413)) {
        toast('Binary or large file — downloading instead.');
        window.location.href = ops.downloadUrl(path);
      } else toast(fail(e), 'err');
    }
  }

  function showEditor(name: string, path: string, content: string): void {
    const ta = el('textarea', { class: 'fm-textarea mono', spellcheck: 'false', wrap: 'off' }) as HTMLTextAreaElement;
    ta.value = content;
    const save = el('button', { class: 'btn btn-portal btn-sm' }, 'Save') as HTMLButtonElement;
    save.addEventListener('click', async () => {
      save.classList.add('is-disabled'); save.textContent = 'Saving…';
      try { await ops.write(path, ta.value); toast(`Saved ${name}`); await load(cwd); }
      catch (e) { toast(fail(e), 'err'); save.classList.remove('is-disabled'); save.textContent = 'Save'; }
    });
    const close = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => void load(cwd) }, 'Close');
    clear(body);
    body.append(el('div', { class: 'fm-edit-head' }, el('span', { class: 'k' }, `Editing /${path.replace(/^\/+/, '')}`), el('div', { class: 'fm-edit-actions' }, save, close)), ta);
    ta.focus();
  }

  void load('/');

  return el('div', { class: 'entry fm' },
    el('div', { class: 'card-head' }, el('span', { class: 'k' }, 'Files'), el('span', { class: 'k t-mute' }, subtitle)),
    el('div', { class: 'fm-bar' }, crumbs, tools),
    body, msg, upInput,
  );
}

void main();
