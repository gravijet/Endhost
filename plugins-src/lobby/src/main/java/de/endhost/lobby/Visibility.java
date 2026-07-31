package de.endhost.lobby;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Who can see whom in the hub. Two independent toggles: a player can hide <em>everyone else</em>
 * (the classic "player hider" for a clean view), and staff can <em>vanish</em> themselves so
 * only other staff see them. Recomputed whenever someone joins, toggles, or leaves so the set
 * stays correct as the lobby fills and empties.
 */
final class Visibility {

    private final EndhostLobby plugin;
    private final Set<UUID> vanished = ConcurrentHashMap.newKeySet();
    private final Set<UUID> hidingOthers = ConcurrentHashMap.newKeySet();

    Visibility(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    boolean isVanished(Player p) {
        return vanished.contains(p.getUniqueId());
    }

    boolean isHidingOthers(Player p) {
        return hidingOthers.contains(p.getUniqueId());
    }

    boolean toggleVanish(Player p) {
        boolean now;
        if (vanished.add(p.getUniqueId())) now = true;
        else { vanished.remove(p.getUniqueId()); now = false; }
        refreshAll();
        return now;
    }

    boolean toggleHideOthers(Player p) {
        boolean now;
        if (hidingOthers.add(p.getUniqueId())) now = true;
        else { hidingOthers.remove(p.getUniqueId()); now = false; }
        applyFor(p);
        return now;
    }

    void onQuit(Player p) {
        vanished.remove(p.getUniqueId());
        hidingOthers.remove(p.getUniqueId());
    }

    /** Recompute visibility for every online viewer. */
    void refreshAll() {
        for (Player viewer : Bukkit.getOnlinePlayers()) applyFor(viewer);
    }

    /** Set which players a single viewer can see, per both toggles. */
    void applyFor(Player viewer) {
        boolean hideAll = hidingOthers.contains(viewer.getUniqueId());
        boolean staff = plugin.ranks().isStaff(viewer);
        for (Player target : Bukkit.getOnlinePlayers()) {
            if (target.equals(viewer)) continue;
            boolean hidden = hideAll || (vanished.contains(target.getUniqueId()) && !staff);
            if (hidden) viewer.hidePlayer(plugin, target);
            else viewer.showPlayer(plugin, target);
        }
    }
}
