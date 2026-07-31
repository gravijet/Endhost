package de.endhost.lobby;

import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.entity.Player;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The panel-owned settings in config.yml: the join address the board shows and the rotating
 * announcement lines. Ranks, prefixes and permissions all live in {@link RankModel} (ranks.json)
 * now; the {@code admins} list here is only a safety fallback so the operator is never locked
 * out of the admin tools before the first ranks.json is written. Spawn lives in {@link SpawnStore}.
 */
final class LobbyConfig {

    private final Set<String> legacyAdmins = new HashSet<>();
    private final List<String> announcements = new ArrayList<>();
    private String address = "example.invalid";

    void reload(FileConfiguration cfg) {
        legacyAdmins.clear();
        for (String a : cfg.getStringList("admins")) {
            String t = a.strip().toLowerCase(Locale.ROOT);
            if (t.isEmpty()) continue;
            legacyAdmins.add(t);
            legacyAdmins.add(t.replace("-", ""));
        }
        address = cfg.getString("address", "example.invalid");

        announcements.clear();
        List<String> lines = cfg.getStringList("announcements");
        if (lines.isEmpty()) {
            announcements.add("&7Right-click the &bcompass &7to hop between servers.");
            announcements.add("&7Fall onto a &aslime pad &7for a boost — or double-jump to fly up.");
            announcements.add("&7Type &e/hub &7from anywhere to come back to the lobby.");
            announcements.add("&7Play at &e" + address + "&7.");
        } else {
            announcements.addAll(lines);
        }
    }

    /** True only for names/UUIDs in the config.yml admins list (or ops) — a fallback for RankModel. */
    boolean legacyAdmin(Player p) {
        if (p.isOp()) return true;
        String name = p.getName().toLowerCase(Locale.ROOT);
        if (legacyAdmins.contains(name)) return true;
        String uuid = p.getUniqueId().toString().toLowerCase(Locale.ROOT);
        return legacyAdmins.contains(uuid) || legacyAdmins.contains(uuid.replace("-", ""));
    }

    String address() {
        return address;
    }

    List<String> announcements() {
        return announcements;
    }
}
