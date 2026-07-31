package de.endhost.proxy;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The proxy's network settings, as written by the panel into {@code config.txt} in this
 * plugin's data directory. A deliberately tiny line-based format (no JSON dependency the
 * proxy API doesn't already guarantee): {@code key=value}, one per line, with {@code \n}
 * standing in for a line break inside a MOTD. Immutable — a reload builds a fresh instance
 * and swaps it in, so a read never sees a half-written config.
 */
final class NetworkConfig {

    private static final LegacyComponentSerializer LEGACY = LegacyComponentSerializer.legacyAmpersand();

    final boolean maintenance;
    final Component motdNormal;
    final Component motdMaintenance;
    final Component kick;
    /** Lowercased usernames and UUIDs (both dashed and undashed) allowed in during maintenance. */
    private final Set<String> whitelist;

    private NetworkConfig(boolean maintenance, Component normal, Component maint, Component kick, Set<String> whitelist) {
        this.maintenance = maintenance;
        this.motdNormal = normal;
        this.motdMaintenance = maint;
        this.kick = kick;
        this.whitelist = whitelist;
    }

    /** Whether a player may join while maintenance is on. */
    boolean allows(String username, String uuid) {
        if (username != null && whitelist.contains(username.toLowerCase())) return true;
        if (uuid == null) return false;
        String u = uuid.toLowerCase();
        return whitelist.contains(u) || whitelist.contains(u.replace("-", ""));
    }

    static NetworkConfig defaults() {
        return new NetworkConfig(false,
                comp("&b&lGRAVIJET NETWORK\n&7Choose a server and play."),
                comp("&6&lGRAVIJET NETWORK\n&e&lMaintenance &7— back soon."),
                comp("&e&lMaintenance\n&7The network is briefly offline. Please check back soon."),
                new HashSet<>());
    }

    static NetworkConfig load(Path file) throws Exception {
        if (!Files.exists(file)) return defaults();
        NetworkConfig d = defaults();
        boolean maintenance = false;
        Component normal = d.motdNormal, maint = d.motdMaintenance, kick = d.kick;
        Set<String> whitelist = new HashSet<>();
        List<String> lines = Files.readAllLines(file);
        for (String line : lines) {
            String s = line.strip();
            if (s.isEmpty() || s.startsWith("#")) continue;
            int eq = s.indexOf('=');
            if (eq < 0) continue;
            String key = s.substring(0, eq).strip();
            String val = s.substring(eq + 1);
            switch (key) {
                case "maintenance" -> maintenance = val.strip().equalsIgnoreCase("true");
                case "motd.normal" -> normal = comp(unescape(val));
                case "motd.maintenance" -> maint = comp(unescape(val));
                case "kick" -> kick = comp(unescape(val));
                case "whitelist" -> {
                    for (String p : val.split(",")) {
                        String t = p.strip().toLowerCase();
                        if (t.isEmpty()) continue;
                        whitelist.add(t);
                        whitelist.add(t.replace("-", ""));
                    }
                }
                default -> { /* unknown key — ignore, forward-compatible */ }
            }
        }
        return new NetworkConfig(maintenance, normal, maint, kick, whitelist);
    }

    private static String unescape(String v) {
        return v.replace("\\n", "\n");
    }

    private static Component comp(String legacy) {
        return LEGACY.deserialize(legacy);
    }
}
