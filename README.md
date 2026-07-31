# Endhost

Minecraft server hosting with a **real** control panel, built in Minecraft's own
GUI grammar, set in The End. Live at **https://example.invalid**.

There are no placeholder numbers and no mock screens: every button in the panel
reaches a real Paper server running in a real container, and where a limit is hit
the panel says which one instead of pretending.

## What it actually does

- **Provisions real servers.** Create one and the backend starts an `itzg/minecraft-server`
  (Paper) container with a fixed RAM/CPU cap and its own port.
- **Real console over RCON.** Commands go through `rcon-cli` and the reply is shown verbatim.
- **Live log stream** over a WebSocket (`docker logs`, demuxed, ANSI-stripped).
- **Real power + status.** Start / stop / restart the container; state, CPU, memory and the
  online player list are read from the daemon every few seconds.
- **Sleeps when empty.** A server empty for 15 minutes is stopped and its memory returned;
  pressing Start wakes it. This is what keeps the free plan free.
- **Honest capacity.** A global ceiling protects the host; when it's reached the panel says so.

## Design

Grounded in Minecraft's multiplayer server list, drawn over the End's void. Monocraft
(SIL OFL) type on the pixel grid, hard drop shadows, beveled Purpur buttons, End Stone
gold headings, ender-portal teal for anything live, a crosshair cursor, and the game's
menu click on every press (`src/web/sound.ts`, `assets/sfx/click.wav`, cut from
`minecraft_click.mp3`). See the header comment in `assets/css/endhost.css`.

## Layout

```
src/server/   TypeScript backend (Express + ws + dockerode)
  config.ts     caps, plan, port range, image
  store.ts      one JSON file, written synchronously
  docker.ts     container lifecycle, RCON, stats, log follow, reconcile
  auth.ts       scrypt passwords, opaque server-side sessions
  index.ts      routes, WebSocket console, idle reaper, boot reconcile
src/web/      browser TypeScript (bundled to public/assets/js)
  home.ts panel.ts sound.ts api.ts mc.ts dom.ts
public/       static site + assets (served by nginx)
scripts/      esbuild builds + PIL texture/icon generator
deploy/       nginx vhost + systemd unit (the live copies)
```

## Build & run

```bash
npm install
npm run build          # esbuild: web bundles + server bundle
npm start              # node dist/server/index.cjs  (needs Docker socket access)
```

The backend needs to reach `/var/run/docker.sock`. In production it runs as the
`endhost.service` systemd unit; the process user must be root or in the `docker` group.

## Deploy (example.invalid)

nginx serves the static site from `/var/www/example.invalid` and reverse-proxies `/api/`
(including the console WebSocket) to the backend on `127.0.0.1:8791`.

```bash
npm run build
sudo rsync -a --delete --exclude='.well-known' public/ /var/www/example.invalid/
sudo cp deploy/example.invalid.conf /etc/nginx/sites-available/example.invalid
sudo cp deploy/endhost.service /etc/systemd/system/endhost.service
sudo systemctl daemon-reload && sudo systemctl enable --now endhost
sudo nginx -t && sudo systemctl reload nginx
```

TLS is a Let's Encrypt origin cert for `example.invalid`, behind Cloudflare (Full/strict).

## For players to actually join (host config, not code)

The panel is fully functional without these, but a friend connecting needs:

1. **DNS** — a DNS-only (grey-cloud) `A` record `example.invalid → <origin IPv4>`.
   Cloudflare can't proxy raw Minecraft TCP, so the join host must bypass the proxy.
   The displayed join host is set by `ENDHOST_JOIN_HOST` (default `example.invalid`).
2. **Firewall** — open the server port range: `sudo ufw allow 25800:25899/tcp`.

## Safety model

This runs on a shared host. The rails in `config.ts`:

- Per container: 1 GB heap / 1.66 GB cgroup cap, 1.5 CPU, `no-new-privileges`, no swap spill.
- Global: **2** servers running at once (~3.3 GB), **6** created total, **1** per account.
- Idle servers sleep after 15 min. Provisioning requires a signed-in account.
- Managed containers are namespaced `endhost-*`; the daemon's own containers are never touched.
- On boot the service removes any `endhost-*` container the datastore no longer knows about.

## Not affiliated

Not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Studios.
Monocraft by Idrees Hassan, SIL Open Font License 1.1.
