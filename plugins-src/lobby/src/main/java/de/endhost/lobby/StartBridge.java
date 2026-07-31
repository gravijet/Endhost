package de.endhost.lobby;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Starting a network server from inside the lobby, without opening any network port back to
 * the panel. The plugin drops a request file into its own volume; the panel (which mounts
 * that volume on the host) sees it, starts the server if the dashboard allows, and writes a
 * response file we read here to tell the player what happened. Files, not sockets — the same
 * trust boundary the panel already has over this volume.
 */
final class StartBridge {

    private final EndhostLobby plugin;
    private final File requestDir;
    private final File responseDir;
    private final Map<String, UUID> pending = new ConcurrentHashMap<>();

    StartBridge(EndhostLobby plugin) {
        this.plugin = plugin;
        this.requestDir = new File(plugin.getDataFolder(), "requests");
        this.responseDir = new File(plugin.getDataFolder(), "responses");
    }

    void init() {
        requestDir.mkdirs();
        responseDir.mkdirs();
    }

    /** Ask the panel to start a server for this player. */
    void request(Player player, String serverKey) {
        String id = UUID.randomUUID().toString().replace("-", "");
        File req = new File(requestDir, id + ".req");
        String body = "key=" + serverKey + "\nplayer=" + player.getName() + "\nuuid=" + player.getUniqueId();
        try {
            Files.writeString(req.toPath(), body, StandardCharsets.UTF_8);
            pending.put(id, player.getUniqueId());
            player.sendMessage(Component.text("Starting that server… you'll be able to join in a moment.", NamedTextColor.AQUA));
        } catch (IOException e) {
            plugin.getLogger().warning("Could not write start request: " + e.getMessage());
            player.sendMessage(Component.text("Couldn't reach the control panel — try again shortly.", NamedTextColor.RED));
        }
    }

    /** Scan for responses the panel has written and deliver them to the waiting players. */
    void tick() {
        File[] files = responseDir.listFiles((d, n) -> n.endsWith(".res"));
        if (files == null) return;
        for (File f : files) {
            String id = f.getName().substring(0, f.getName().length() - 4);
            String ok = "false";
            String message = "The server could not be started right now.";
            try {
                for (String line : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
                    int eq = line.indexOf('=');
                    if (eq < 0) continue;
                    String k = line.substring(0, eq).strip();
                    String v = line.substring(eq + 1);
                    if (k.equals("ok")) ok = v.strip();
                    else if (k.equals("message")) message = v;
                }
            } catch (IOException e) {
                // Fall through with the default message; still consume the file below.
            }
            UUID who = pending.remove(id);
            if (who != null) {
                Player p = Bukkit.getPlayer(who);
                if (p != null && p.isOnline()) {
                    boolean success = ok.equalsIgnoreCase("true");
                    p.sendMessage(Component.text(message, success ? NamedTextColor.GREEN : NamedTextColor.RED));
                }
            }
            f.delete();
        }
    }
}
