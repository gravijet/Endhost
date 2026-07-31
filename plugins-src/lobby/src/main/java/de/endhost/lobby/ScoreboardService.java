package de.endhost.lobby;

import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.scoreboard.Criteria;
import org.bukkit.scoreboard.DisplaySlot;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The lobby's tablist, sidebar scoreboard and rank nametags — the job TAB + PlaceholderAPI used
 * to do, in a few hundred lines we own. Each player gets their own scoreboard so the sidebar can
 * show their rank and ping; a team per rank on every board gives the coloured prefix above heads
 * and sorts the tab list by rank weight (highest first). Lines update flicker-free by keeping
 * fixed invisible entries and only rewriting each line's team prefix.
 */
final class ScoreboardService {

    /** Fixed, invisible per-line entries (colour codes render as nothing). */
    private static final String[] ENTRY = new String[15];
    static {
        char[] codes = "0123456789abcde".toCharArray();
        for (int i = 0; i < ENTRY.length; i++) ENTRY[i] = "§" + codes[i];
    }
    private static final String SEP = "&8&m                    ";

    private final EndhostLobby plugin;
    private final Map<UUID, Scoreboard> boards = new HashMap<>();

    ScoreboardService(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    void onJoin(Player player) {
        buildBoard(player);
        resyncRanks();
    }

    void onQuit(Player player) {
        boards.remove(player.getUniqueId());
        resyncRanks();
    }

    /** Refresh the dynamic bits (online count, ping) and the tablist for everyone. */
    void tick() {
        int online = Bukkit.getOnlinePlayers().size();
        for (Player p : Bukkit.getOnlinePlayers()) {
            updateSidebar(p, online);
            updateTablist(p, online);
        }
    }

    private void buildBoard(Player player) {
        if (Bukkit.getScoreboardManager() == null) return; // no world yet — nothing to attach to
        Scoreboard board = Bukkit.getScoreboardManager().getNewScoreboard();
        Objective obj = board.registerNewObjective("eh", Criteria.DUMMY, Text.of("&b&lGRAVIJET"));
        obj.setDisplaySlot(DisplaySlot.SIDEBAR);

        String[] lines = sidebarLines(player, Bukkit.getOnlinePlayers().size());
        for (int i = 0; i < lines.length; i++) {
            Team t = board.registerNewTeam("line" + i);
            t.addEntry(ENTRY[i]);
            t.prefix(Text.of(lines[i]));
            obj.getScore(ENTRY[i]).setScore(lines.length - i);
        }

        boards.put(player.getUniqueId(), board);
        player.setScoreboard(board);
        applyRankTeams(board);
    }

    private void updateSidebar(Player player, int online) {
        Scoreboard board = boards.get(player.getUniqueId());
        if (board == null) return;
        String[] lines = sidebarLines(player, online);
        for (int i = 0; i < lines.length; i++) {
            Team t = board.getTeam("line" + i);
            if (t != null) t.prefix(Text.of(lines[i]));
        }
    }

    private String[] sidebarLines(Player player, int online) {
        RankModel.Rank r = plugin.ranks().rankOf(player);
        return new String[]{
                SEP,
                "&fRank &8» " + r.color + r.name,
                "&fOnline &8» &a" + online,
                "&fPing &8» &a" + player.getPing() + "&7ms",
                SEP,
                "&e" + plugin.config().address(),
        };
    }

    private void updateTablist(Player player, int online) {
        RankModel.Rank r = plugin.ranks().rankOf(player);
        Component header = Text.of("&b&lGRAVIJET &7NETWORK\n&8Willkommen, &f" + player.getName() + "\n ");
        Component footer = Text.of(" \n&7Online: &a" + online + "  &8•  &7Ping: &a" + player.getPing()
                + "&7ms\n&e" + plugin.config().address());
        player.sendPlayerListHeaderAndFooter(header, footer);
        player.playerListName(Text.of(r.prefix + r.color + player.getName()));
    }

    /** Rebuild the rank teams on every board and put each online player into their rank's team. */
    void resyncRanks() {
        for (Scoreboard board : boards.values()) applyRankTeams(board);
    }

    /** Create one team per rank (sorted by weight) on a board and slot players into them. */
    private void applyRankTeams(Scoreboard board) {
        for (Team t : board.getTeams()) {
            if (t.getName().startsWith("rk")) t.unregister();
        }
        List<RankModel.Rank> ranks = plugin.ranks().ranks(); // highest weight first
        Map<String, String> teamOf = new HashMap<>();
        for (int i = 0; i < ranks.size(); i++) {
            RankModel.Rank r = ranks.get(i);
            String teamName = "rk" + String.format("%02d", Math.min(i, 99));
            Team team = board.getTeam(teamName);
            if (team == null) team = board.registerNewTeam(teamName);
            team.prefix(Text.of(r.prefix));
            teamOf.put(r.id, teamName);
        }
        for (Player p : Bukkit.getOnlinePlayers()) {
            String teamName = teamOf.get(plugin.ranks().rankOf(p).id);
            if (teamName == null) continue;
            Team team = board.getTeam(teamName);
            if (team != null && !team.hasEntry(p.getName())) team.addEntry(p.getName());
        }
    }
}
