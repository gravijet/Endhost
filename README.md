# Endhost

Minecraft server control panel with Docker-based provisioning, resource limits, power controls and a WebSocket console.

```sh
npm install
npm run build:plugins
npm run build
npm run typecheck
npm start
```

Requires Node.js 20 or newer, JDK 21 and access to a Docker daemon. Build the proxy and lobby plugins before starting the panel. Configure server limits, the port range and the public join address through the environment.

Not affiliated with Mojang or Microsoft. Monocraft is licensed under the SIL Open Font License 1.1.
