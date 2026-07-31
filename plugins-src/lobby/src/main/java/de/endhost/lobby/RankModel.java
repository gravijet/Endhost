package de.endhost.lobby;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.entity.Player;

import java.io.File;
import java.io.FileReader;
import java.io.Reader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The network's ranks, read from {@code ranks.json} in the plugin folder — the single source of
 * truth the panel writes and both this lobby plugin and the proxy plugin consume, so a rank
 * defined once applies everywhere ("permissions synced between Velocity and the lobby"). Each
 * rank carries a chat/tab prefix, a name colour, a sort weight and a set of permission nodes;
 * a player is mapped to one rank by UUID or name, and everyone else is the default rank.
 *
 * <p>Permission nodes match literally, by prefix wildcard ({@code endhost.command.*}) or by the
 * global {@code *}. The file is watched by timestamp and reloaded on change, so a rank edit in
 * the dashboard takes effect within a couple of seconds without a restart.
 */
final class RankModel {

    /** One rank: id, display name, legacy-coded prefix and name colour, sort weight, permissions. */
    static final class Rank {
        final String id;
        final String name;
        final String prefix;
        final String color;
        final int weight;
        final Set<String> perms;

        Rank(String id, String name, String prefix, String color, int weight, Set<String> perms) {
            this.id = id;
            this.name = name;
            this.prefix = prefix;
            this.color = color;
            this.weight = weight;
            this.perms = perms;
        }
    }

    private static final Rank FALLBACK = new Rank("default", "Member", "", "&7", 0, Set.of());

    private final EndhostLobby plugin;
    private final File file;
    private volatile long lastModified = -1;
    private volatile Map<String, Rank> byId = Map.of("default", FALLBACK);
    private volatile List<Rank> byWeight = List.of(FALLBACK);
    private volatile Map<String, String> players = Map.of();
    private volatile String defaultId = "default";

    RankModel(EndhostLobby plugin) {
        this.plugin = plugin;
        this.file = new File(plugin.getDataFolder(), "ranks.json");
    }

    /** Reload if the file changed on disk; returns true when it actually reloaded. */
    boolean reloadIfChanged() {
        long m = file.exists() ? file.lastModified() : -1;
        if (m == lastModified) return false;
        reload();
        return true;
    }

    void reload() {
        lastModified = file.exists() ? file.lastModified() : -1;
        if (!file.exists()) return; // keep whatever we have (defaults on first run)
        try (Reader r = new FileReader(file)) {
            JsonObject root = JsonParser.parseReader(r).getAsJsonObject();
            Map<String, Rank> ranks = new LinkedHashMap<>();
            JsonArray arr = root.has("ranks") ? root.getAsJsonArray("ranks") : new JsonArray();
            for (JsonElement el : arr) {
                JsonObject o = el.getAsJsonObject();
                String id = str(o, "id");
                if (id.isEmpty()) continue;
                Set<String> perms = new TreeSet<>();
                if (o.has("permissions") && o.get("permissions").isJsonArray()) {
                    for (JsonElement p : o.getAsJsonArray("permissions")) {
                        String node = p.getAsString().strip().toLowerCase(Locale.ROOT);
                        if (!node.isEmpty()) perms.add(node);
                    }
                }
                ranks.put(id.toLowerCase(Locale.ROOT), new Rank(
                        id.toLowerCase(Locale.ROOT),
                        o.has("name") ? o.get("name").getAsString() : id,
                        o.has("prefix") ? o.get("prefix").getAsString() : "",
                        o.has("color") ? o.get("color").getAsString() : "&7",
                        o.has("weight") ? o.get("weight").getAsInt() : 0,
                        perms));
            }
            if (ranks.isEmpty()) ranks.put("default", FALLBACK);

            Map<String, String> map = new HashMap<>();
            if (root.has("players") && root.get("players").isJsonObject()) {
                for (Map.Entry<String, JsonElement> e : root.getAsJsonObject("players").entrySet()) {
                    String key = e.getKey().strip().toLowerCase(Locale.ROOT);
                    String rank = e.getValue().getAsString().strip().toLowerCase(Locale.ROOT);
                    if (key.isEmpty() || !ranks.containsKey(rank)) continue;
                    map.put(key, rank);
                    map.put(key.replace("-", ""), rank);
                }
            }
            String def = root.has("default") ? root.get("default").getAsString().toLowerCase(Locale.ROOT) : "default";
            if (!ranks.containsKey(def)) def = ranks.keySet().iterator().next();

            List<Rank> sorted = new ArrayList<>(ranks.values());
            sorted.sort((a, b) -> b.weight - a.weight);

            this.byId = ranks;
            this.byWeight = sorted;
            this.players = map;
            this.defaultId = def;
        } catch (Exception e) {
            plugin.getLogger().warning("Could not read ranks.json: " + e.getMessage());
        }
    }

    /** Every rank, highest weight first — for the scoreboard/tab team ordering. */
    List<Rank> ranks() {
        return byWeight;
    }

    /** The rank a player carries: their explicit mapping, else the default rank. */
    Rank rankOf(Player p) {
        String uuid = p.getUniqueId().toString().toLowerCase(Locale.ROOT);
        String id = players.get(uuid);
        if (id == null) id = players.get(uuid.replace("-", ""));
        if (id == null) id = players.get(p.getName().toLowerCase(Locale.ROOT));
        if (id != null) {
            Rank r = byId.get(id);
            if (r != null) return r;
        }
        if (plugin.config().legacyAdmin(p)) {
            Rank owner = highestWithStar();
            if (owner != null) return owner;
        }
        Rank def = byId.get(defaultId);
        return def != null ? def : FALLBACK;
    }

    /** Whether a player has a permission node (op and legacy config admins always do). */
    boolean has(Player p, String node) {
        if (p.isOp()) return true;
        if (plugin.config().legacyAdmin(p)) return true;
        return matches(rankOf(p).perms, node.toLowerCase(Locale.ROOT));
    }

    /** The build/manage bypass — staff can break blocks, keep their gamemode, edit their hotbar. */
    boolean isStaff(Player p) {
        return has(p, "endhost.build");
    }

    String prefixOf(Player p) {
        return rankOf(p).prefix;
    }

    /** From a set of known concrete nodes, the subset this player effectively holds. */
    Set<String> grantedFrom(Player p, Iterable<String> known) {
        Set<String> out = new TreeSet<>();
        if (p.isOp() || plugin.config().legacyAdmin(p)) {
            for (String n : known) out.add(n);
            return out;
        }
        Set<String> perms = rankOf(p).perms;
        for (String n : known) if (matches(perms, n)) out.add(n);
        return out;
    }

    private Rank highestWithStar() {
        for (Rank r : byWeight) if (r.perms.contains("*")) return r;
        return byWeight.isEmpty() ? null : byWeight.get(0);
    }

    private static boolean matches(Set<String> perms, String node) {
        if (perms.contains("*") || perms.contains(node)) return true;
        for (String p : perms) {
            if (p.endsWith(".*") && node.startsWith(p.substring(0, p.length() - 1))) return true;
        }
        return false;
    }

    private static String str(JsonObject o, String k) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : "";
    }
}
