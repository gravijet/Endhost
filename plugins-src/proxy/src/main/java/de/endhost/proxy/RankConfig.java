package de.endhost.proxy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The proxy's half of the shared rank system. The panel derives {@code ranks.txt} from the same
 * rank model the lobby reads as {@code ranks.json}, expanding each player's rank into its flat
 * set of permission nodes — so a rank defined once in the dashboard governs both the lobby and
 * the proxy. A deliberately tiny, dependency-free line format (the proxy API guarantees no JSON):
 *
 * <pre>
 *   default=node,node          # everyone with no explicit rank
 *   name:&lt;lowercase&gt;=node,node  # a player matched by name
 *   uuid:&lt;undashed&gt;=node,node   # a player matched by UUID
 * </pre>
 *
 * Nodes match literally, by prefix wildcard ({@code endhost.*}) or by the global {@code *}.
 */
final class RankConfig {

    private final Map<String, Set<String>> byName;
    private final Map<String, Set<String>> byUuid;
    private final Set<String> defaults;

    private RankConfig(Map<String, Set<String>> byName, Map<String, Set<String>> byUuid, Set<String> defaults) {
        this.byName = byName;
        this.byUuid = byUuid;
        this.defaults = defaults;
    }

    static RankConfig empty() {
        return new RankConfig(new HashMap<>(), new HashMap<>(), new HashSet<>());
    }

    static RankConfig load(Path file) throws Exception {
        if (!Files.exists(file)) return empty();
        Map<String, Set<String>> byName = new HashMap<>();
        Map<String, Set<String>> byUuid = new HashMap<>();
        Set<String> defaults = new HashSet<>();
        List<String> lines = Files.readAllLines(file);
        for (String raw : lines) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) continue;
            int eq = line.indexOf('=');
            if (eq < 0) continue;
            String key = line.substring(0, eq).strip().toLowerCase(Locale.ROOT);
            Set<String> perms = parsePerms(line.substring(eq + 1));
            if (key.equals("default")) defaults.addAll(perms);
            else if (key.startsWith("name:")) byName.put(key.substring(5), perms);
            else if (key.startsWith("uuid:")) byUuid.put(key.substring(5).replace("-", ""), perms);
        }
        return new RankConfig(byName, byUuid, defaults);
    }

    private static Set<String> parsePerms(String value) {
        Set<String> perms = new HashSet<>();
        for (String p : value.split(",")) {
            String node = p.strip().toLowerCase(Locale.ROOT);
            if (!node.isEmpty()) perms.add(node);
        }
        return perms;
    }

    /** The permission nodes a player carries: by UUID, else by name, else the default set. */
    private Set<String> permsFor(String username, String uuid) {
        if (uuid != null) {
            Set<String> u = byUuid.get(uuid.toLowerCase(Locale.ROOT).replace("-", ""));
            if (u != null) return u;
        }
        if (username != null) {
            Set<String> n = byName.get(username.toLowerCase(Locale.ROOT));
            if (n != null) return n;
        }
        return defaults;
    }

    /** Whether a player has a permission node (with * and prefix-wildcard support). */
    boolean has(String username, String uuid, String node) {
        Set<String> perms = permsFor(username, uuid);
        String n = node.toLowerCase(Locale.ROOT);
        if (perms.contains("*") || perms.contains(n)) return true;
        for (String p : perms) {
            if (p.endsWith(".*") && n.startsWith(p.substring(0, p.length() - 1))) return true;
        }
        return false;
    }
}
