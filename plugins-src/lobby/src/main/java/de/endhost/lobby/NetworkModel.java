package de.endhost.lobby;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.plugin.Plugin;

import java.io.File;
import java.io.FileReader;
import java.io.Reader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The network as the panel sees it, read from network.json in the plugin folder. The panel
 * rewrites this file on every network change (a server starting, stopping, being created or
 * hidden); we re-read it when its timestamp moves. The lobby itself is never in the list.
 */
final class NetworkModel {

    /** One selectable server. */
    static final class Entry {
        final String key;       // the Velocity server name used to connect
        final String name;      // display name
        final String material;  // Bukkit material for the icon
        final String status;    // online | starting | restarting | offline
        final boolean online;
        final int players;
        final int maxPlayers;
        final boolean startable;

        Entry(String key, String name, String material, String status, boolean online, int players, int maxPlayers, boolean startable) {
            this.key = key;
            this.name = name;
            this.material = material;
            this.status = status;
            this.online = online;
            this.players = players;
            this.maxPlayers = maxPlayers;
            this.startable = startable;
        }
    }

    private final Plugin plugin;
    private final File file;
    private volatile List<Entry> servers = Collections.emptyList();
    private volatile long lastModified = -1;

    NetworkModel(Plugin plugin) {
        this.plugin = plugin;
        this.file = new File(plugin.getDataFolder(), "network.json");
    }

    List<Entry> servers() {
        return servers;
    }

    void reloadIfChanged() {
        long m = file.exists() ? file.lastModified() : -1;
        if (m != lastModified) reload();
    }

    void reload() {
        lastModified = file.exists() ? file.lastModified() : -1;
        if (!file.exists()) { servers = Collections.emptyList(); return; }
        List<Entry> out = new ArrayList<>();
        try (Reader r = new FileReader(file)) {
            JsonObject root = JsonParser.parseReader(r).getAsJsonObject();
            JsonArray arr = root.has("servers") ? root.getAsJsonArray("servers") : new JsonArray();
            for (JsonElement el : arr) {
                JsonObject o = el.getAsJsonObject();
                boolean online = o.has("online") && o.get("online").getAsBoolean();
                String status = o.has("status") && !o.get("status").isJsonNull()
                        ? o.get("status").getAsString() : (online ? "online" : "offline");
                out.add(new Entry(
                        str(o, "key"),
                        str(o, "name"),
                        o.has("material") ? o.get("material").getAsString() : "GRASS_BLOCK",
                        status,
                        online,
                        o.has("players") ? o.get("players").getAsInt() : 0,
                        o.has("maxPlayers") ? o.get("maxPlayers").getAsInt() : 20,
                        o.has("startable") && o.get("startable").getAsBoolean()));
            }
        } catch (Exception e) {
            plugin.getLogger().warning("Could not read network.json: " + e.getMessage());
            return; // keep the previous list rather than blanking the menu on a transient error
        }
        servers = out;
    }

    private static String str(JsonObject o, String k) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : "";
    }
}
