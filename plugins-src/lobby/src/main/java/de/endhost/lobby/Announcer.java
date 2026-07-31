package de.endhost.lobby;

import org.bukkit.Bukkit;
import org.bukkit.Sound;
import org.bukkit.entity.Player;

import java.util.List;

/**
 * Rotating hub tips: every so often one line from the configured list is broadcast to everyone
 * with a soft chime, cycling through in order. Purely cosmetic flavour — the same "did you
 * know…" ticker a polished free host runs — driven off {@link LobbyConfig}'s announcement list.
 */
final class Announcer {

    private final EndhostLobby plugin;
    private int index;

    Announcer(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    void broadcastNext() {
        List<String> lines = plugin.config().announcements();
        if (lines.isEmpty() || Bukkit.getOnlinePlayers().isEmpty()) return;
        String line = lines.get(index % lines.size());
        index++;
        Bukkit.broadcast(Text.of("&8» &b&lTIP &8» &r" + line));
        for (Player p : Bukkit.getOnlinePlayers()) {
            p.playSound(p.getLocation(), Sound.BLOCK_NOTE_BLOCK_PLING, 0.5f, 1.6f);
        }
    }
}
