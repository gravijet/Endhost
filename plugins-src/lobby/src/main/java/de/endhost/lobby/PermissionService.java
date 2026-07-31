package de.endhost.lobby;

import org.bukkit.entity.Player;
import org.bukkit.permissions.PermissionAttachment;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Makes a player's rank real to Bukkit itself: on join (and whenever ranks reload) each player
 * gets a permission attachment carrying exactly the nodes their rank grants, so
 * {@code player.hasPermission(...)} agrees with the rank file the proxy reads too. Our own
 * commands consult {@link RankModel} directly, but this keeps any third-party plugin — and the
 * game's own permission checks — in sync with the same source of truth.
 */
final class PermissionService {

    /** The concrete permission nodes the lobby knows about — what an attachment can grant. */
    static final List<String> KNOWN = List.of(
            "endhost.admin", "endhost.staff", "endhost.build",
            "endhost.command.setspawn", "endhost.command.gm", "endhost.command.gmc",
            "endhost.command.gms", "endhost.command.gma", "endhost.command.gmsp",
            "endhost.command.fly", "endhost.command.speed", "endhost.command.tp",
            "endhost.command.tphere", "endhost.command.broadcast", "endhost.command.heal",
            "endhost.command.feed", "endhost.command.day", "endhost.command.night",
            "endhost.command.lobbyreload", "endhost.command.vanish", "endhost.command.clearchat");

    private final EndhostLobby plugin;
    private final Map<UUID, PermissionAttachment> attachments = new ConcurrentHashMap<>();

    PermissionService(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    /** Attach (or refresh) the permission nodes this player's rank grants. */
    void apply(Player player) {
        PermissionAttachment att = attachments.remove(player.getUniqueId());
        if (att != null) try { player.removeAttachment(att); } catch (IllegalArgumentException ignored) { /* stale */ }
        att = player.addAttachment(plugin);
        for (String node : KNOWN) att.setPermission(node, plugin.ranks().has(player, node));
        attachments.put(player.getUniqueId(), att);
        player.recalculatePermissions();
    }

    /** Re-apply to everyone — used after a ranks.json reload. */
    void applyAll() {
        for (Player p : plugin.getServer().getOnlinePlayers()) apply(p);
    }

    void clear(Player player) {
        PermissionAttachment att = attachments.remove(player.getUniqueId());
        if (att != null) try { player.removeAttachment(att); } catch (IllegalArgumentException ignored) { /* already gone */ }
    }
}
