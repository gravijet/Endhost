package de.endhost.proxy;

import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The bridge that lets in-game commands reach the panel without opening any port back to it.
 * The proxy drops a request file into its own data directory; the panel (which mounts this
 * volume on the host) reads it, acts on it — linking a Minecraft account, an owner's
 * start/stop/restart, a staff /maintenance toggle — and writes a reply file the bridge reads
 * on its scheduled tick and delivers to the waiting player. Files, not sockets: the same trust
 * boundary the panel already has over this volume.
 */
final class ControlBridge {

    private final ProxyServer server;
    private final org.slf4j.Logger logger;
    private final Path requestDir;
    private final Path responseDir;
    // Request id -> who is waiting, and what kind of request it was (so a /myservers reply is
    // formatted as a list rather than a single line).
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    private record Pending(UUID player, String type) {}

    ControlBridge(ProxyServer server, org.slf4j.Logger logger, Path dataDirectory) {
        this.server = server;
        this.logger = logger;
        Path control = dataDirectory.resolve("control");
        this.requestDir = control.resolve("requests");
        this.responseDir = control.resolve("responses");
    }

    void init() {
        try {
            Files.createDirectories(requestDir);
            Files.createDirectories(responseDir);
        } catch (IOException e) {
            logger.warn("Could not create the control bridge directories: {}", e.getMessage());
        }
    }

    /** Submit a request for a player and tell them it's on its way. Fields are written verbatim. */
    void submit(Player player, String type, Map<String, String> fields, String pendingMessage) {
        String id = UUID.randomUUID().toString().replace("-", "");
        Map<String, String> body = new LinkedHashMap<>();
        body.put("type", type);
        body.put("uuid", player.getUniqueId().toString());
        body.put("name", player.getUsername());
        body.putAll(fields);
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : body.entrySet()) {
            sb.append(e.getKey()).append('=').append(e.getValue().replace("\n", " ")).append('\n');
        }
        try {
            Files.writeString(requestDir.resolve(id + ".req"), sb.toString(), StandardCharsets.UTF_8);
            pending.put(id, new Pending(player.getUniqueId(), type));
            if (pendingMessage != null) player.sendMessage(Component.text(pendingMessage, NamedTextColor.AQUA));
        } catch (IOException e) {
            logger.warn("Could not write control request: {}", e.getMessage());
            player.sendMessage(Component.text("Couldn't reach the control panel — try again shortly.", NamedTextColor.RED));
        }
    }

    /** Read any replies the panel has written and deliver them. Called on a repeating task. */
    void tick() {
        List<Path> files;
        try (var stream = Files.list(responseDir)) {
            files = stream.filter(p -> p.getFileName().toString().endsWith(".res")).toList();
        } catch (IOException e) {
            return; // directory not there yet, or a transient hiccup
        }
        for (Path f : files) {
            String fn = f.getFileName().toString();
            String id = fn.substring(0, fn.length() - 4);
            Map<String, String> kv = new LinkedHashMap<>();
            try {
                for (String line : Files.readAllLines(f, StandardCharsets.UTF_8)) {
                    int i = line.indexOf('=');
                    if (i < 0) continue;
                    kv.put(line.substring(0, i).trim(), line.substring(i + 1));
                }
            } catch (IOException ignored) {
                // fall through with whatever we have; the file is still consumed below
            }
            Pending p = pending.remove(id);
            if (p != null) deliver(p, kv);
            try { Files.deleteIfExists(f); } catch (IOException ignored) { /* try again next tick */ }
        }
    }

    private void deliver(Pending p, Map<String, String> kv) {
        Player player = server.getPlayer(p.player()).orElse(null);
        if (player == null || !player.isActive()) return;
        boolean ok = "true".equalsIgnoreCase(kv.getOrDefault("ok", "false"));

        if ("list".equals(p.type()) && kv.containsKey("servers")) {
            player.sendMessage(Component.text("Your servers:", NamedTextColor.AQUA));
            List<String> rows = new ArrayList<>();
            for (String row : kv.get("servers").split("\\|\\|")) if (!row.isBlank()) rows.add(row);
            if (rows.isEmpty()) {
                player.sendMessage(Component.text("  (none yet)", NamedTextColor.GRAY));
            } else {
                for (String row : rows) {
                    NamedTextColor colour = row.toLowerCase().contains("online") ? NamedTextColor.GREEN : NamedTextColor.GRAY;
                    player.sendMessage(Component.text("  • " + row, colour));
                }
                player.sendMessage(Component.text("Use /start <server>, /stop <server> or /restart <server>.", NamedTextColor.DARK_GRAY));
            }
            return;
        }

        String message = kv.getOrDefault("message", ok ? "Done." : "That didn't work.");
        player.sendMessage(Component.text(message, ok ? NamedTextColor.GREEN : NamedTextColor.RED));
    }
}
