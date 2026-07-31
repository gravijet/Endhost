package de.endhost.lobby;

import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

import java.util.Locale;

/**
 * Every lobby command in one place, routed by label. Player commands (spawn, servers, start,
 * rank, players) are open to everyone; the admin tools are gated by the matching
 * {@code endhost.command.<name>} permission node, which the rank system grants. Kept as one
 * router so the command surface reads top-to-bottom.
 */
final class CommandRouter implements CommandExecutor {

    private final EndhostLobby plugin;

    CommandRouter(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        switch (command.getName().toLowerCase(Locale.ROOT)) {
            case "setspawn" -> setspawn(sender);
            case "spawn" -> spawn(sender);
            case "servers" -> servers(sender);
            case "start" -> start(sender, args);
            case "players" -> togglePlayers(sender);
            case "rank" -> rank(sender, args);
            case "gm" -> gamemode(sender, args.length > 0 ? args[0] : "", arg(args, 1));
            case "gmc" -> gamemode(sender, "creative", arg(args, 0));
            case "gms" -> gamemode(sender, "survival", arg(args, 0));
            case "gma" -> gamemode(sender, "adventure", arg(args, 0));
            case "gmsp" -> gamemode(sender, "spectator", arg(args, 0));
            case "fly" -> fly(sender, arg(args, 0));
            case "speed" -> speed(sender, args.length > 0 ? args[0] : "");
            case "tp" -> tp(sender, args.length > 0 ? args[0] : "");
            case "tphere" -> tphere(sender, args.length > 0 ? args[0] : "");
            case "broadcast" -> broadcast(sender, args);
            case "heal" -> heal(sender, arg(args, 0));
            case "feed" -> feed(sender, arg(args, 0));
            case "day" -> setTime(sender, 1000, "day");
            case "night" -> setTime(sender, 13000, "night");
            case "vanish" -> vanish(sender);
            case "clearchat" -> clearchat(sender);
            case "lobbyreload" -> reload(sender);
            default -> { return false; }
        }
        return true;
    }

    // ---- player commands ----

    private void spawn(CommandSender sender) {
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        Location s = plugin.spawn().get();
        if (s == null) { msg(p, "&cNo spawn is set yet."); return; }
        p.teleport(s);
        msg(p, "&7Welcome back to spawn.");
    }

    private void servers(CommandSender sender) {
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        plugin.selector().open(p, 0);
    }

    private void start(CommandSender sender, String[] args) {
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        if (args.length < 1) { msg(p, "&7Usage: &f/start <server>"); return; }
        String q = args[0].toLowerCase(Locale.ROOT);
        NetworkModel.Entry match = null;
        for (NetworkModel.Entry e : plugin.network().servers()) {
            if (e.name.toLowerCase(Locale.ROOT).equals(q) || e.key.toLowerCase(Locale.ROOT).equals(q)) { match = e; break; }
        }
        if (match == null) { msg(p, "&cNo network server called '" + args[0] + "'."); return; }
        if (match.online) { msg(p, "&a" + match.name + " is already online — connecting you."); plugin.connectTo(p, match.key, match.name); return; }
        if (match.startable) { plugin.startBridge().request(p, match.key); return; }
        msg(p, "&7" + match.name + " can't be started from the lobby. &8Ask an admin.");
    }

    private void togglePlayers(CommandSender sender) {
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        boolean hiding = plugin.visibility().toggleHideOthers(p);
        plugin.updateVisibilityItem(p);
        msg(p, hiding ? "&7Other players are now &chidden&7." : "&7Other players are now &avisible&7.");
    }

    private void rank(CommandSender sender, String[] args) {
        Player target;
        if (args.length > 0) {
            target = Bukkit.getPlayerExact(args[0]);
            if (target == null) { msg(sender, "&cPlayer not found."); return; }
        } else if (sender instanceof Player p) {
            target = p;
        } else { msg(sender, "&7Usage: &f/rank <player>"); return; }
        RankModel.Rank r = plugin.ranks().rankOf(target);
        msg(sender, "&7" + target.getName() + "'s rank: " + r.color + r.name + " &8(weight " + r.weight + ")");
    }

    // ---- admin commands ----

    private void setspawn(CommandSender sender) {
        Player p = require(sender, "setspawn");
        if (p == null) return;
        plugin.spawn().set(p.getLocation());
        p.getWorld().setSpawnLocation(p.getLocation());
        msg(p, "&aLobby spawn set here.");
    }

    private void gamemode(CommandSender sender, String mode, String target) {
        if (!can(sender, "gm")) return;
        GameMode gm = switch (mode.toLowerCase(Locale.ROOT)) {
            case "creative", "c", "1" -> GameMode.CREATIVE;
            case "survival", "s", "0" -> GameMode.SURVIVAL;
            case "adventure", "a", "2" -> GameMode.ADVENTURE;
            case "spectator", "sp", "3" -> GameMode.SPECTATOR;
            default -> null;
        };
        if (gm == null) { msg(sender, "&7Usage: &f/gm <survival|creative|adventure|spectator> [player]"); return; }
        Player who = resolve(sender, target);
        if (who == null) return;
        who.setGameMode(gm);
        msg(sender, "&aSet " + who.getName() + " to " + gm.name().toLowerCase(Locale.ROOT) + " mode.");
    }

    private void fly(CommandSender sender, String target) {
        if (!can(sender, "fly")) return;
        Player who = resolve(sender, target);
        if (who == null) return;
        boolean on = plugin.flyMode().add(who.getUniqueId());
        if (!on) plugin.flyMode().remove(who.getUniqueId());
        who.setAllowFlight(true);       // never remove flight entirely — the double-jump needs it
        who.setFlying(on);
        msg(sender, "&aFlight " + (on ? "enabled" : "disabled") + " for " + who.getName() + ".");
    }

    private void speed(CommandSender sender, String raw) {
        if (!can(sender, "speed")) return;
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        int n;
        try { n = Integer.parseInt(raw); } catch (NumberFormatException e) { msg(sender, "&7Usage: &f/speed <1-10>"); return; }
        n = Math.max(1, Math.min(10, n));
        float v = n / 10f;
        p.setFlySpeed(v);
        p.setWalkSpeed(v);
        msg(sender, "&aSpeed set to " + n + ".");
    }

    private void tp(CommandSender sender, String target) {
        if (!can(sender, "tp")) return;
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        Player who = Bukkit.getPlayerExact(target);
        if (who == null) { msg(sender, "&cPlayer not found."); return; }
        p.teleport(who);
        msg(sender, "&aTeleported to " + who.getName() + ".");
    }

    private void tphere(CommandSender sender, String target) {
        if (!can(sender, "tphere")) return;
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        Player who = Bukkit.getPlayerExact(target);
        if (who == null) { msg(sender, "&cPlayer not found."); return; }
        who.teleport(p);
        msg(sender, "&aTeleported " + who.getName() + " to you.");
    }

    private void broadcast(CommandSender sender, String[] args) {
        if (!can(sender, "broadcast")) return;
        if (args.length == 0) { msg(sender, "&7Usage: &f/broadcast <message>"); return; }
        String message = String.join(" ", args);
        Bukkit.broadcast(Text.of("&b&lNETWORK &8» &f" + message));
    }

    private void heal(CommandSender sender, String target) {
        if (!can(sender, "heal")) return;
        Player who = resolve(sender, target);
        if (who == null) return;
        who.setHealth(20.0);
        who.setFireTicks(0);
        msg(sender, "&aHealed " + who.getName() + ".");
    }

    private void feed(CommandSender sender, String target) {
        if (!can(sender, "feed")) return;
        Player who = resolve(sender, target);
        if (who == null) return;
        who.setFoodLevel(20);
        who.setSaturation(20f);
        msg(sender, "&aFed " + who.getName() + ".");
    }

    private void setTime(CommandSender sender, int time, String label) {
        if (!can(sender, label)) return;
        if (!(sender instanceof Player p)) { msg(sender, "&cPlayers only."); return; }
        p.getWorld().setTime(time);
        msg(sender, "&aSet the time to " + label + ".");
    }

    private void vanish(CommandSender sender) {
        Player p = require(sender, "vanish");
        if (p == null) return;
        boolean on = plugin.visibility().toggleVanish(p);
        plugin.perms().apply(p);
        msg(p, on ? "&7You are now &fvanished&7 — only staff can see you." : "&aYou are visible again.");
    }

    private void clearchat(CommandSender sender) {
        if (!can(sender, "clearchat")) return;
        for (Player p : Bukkit.getOnlinePlayers()) {
            for (int i = 0; i < 100; i++) p.sendMessage(Text.of(" "));
        }
        String who = sender instanceof Player p ? p.getName() : "Console";
        Bukkit.broadcast(Text.of("&b&lNETWORK &8» &7Chat cleared by &f" + who + "&7."));
    }

    private void reload(CommandSender sender) {
        if (!can(sender, "lobbyreload")) return;
        plugin.reloadAll();
        msg(sender, "&aLobby config, ranks and network list reloaded.");
    }

    // ---- helpers ----

    /** Resolve an optional [player] argument, defaulting to the sender. */
    private Player resolve(CommandSender sender, String target) {
        if (target == null || target.isBlank()) {
            if (sender instanceof Player p) return p;
            msg(sender, "&cName a player from the console.");
            return null;
        }
        Player who = Bukkit.getPlayerExact(target);
        if (who == null) msg(sender, "&cPlayer not found.");
        return who;
    }

    /** Permission gate for an admin command that needs a player sender; returns the player or null. */
    private Player require(CommandSender sender, String node) {
        if (!can(sender, node)) return null;
        if (sender instanceof Player p) return p;
        msg(sender, "&cPlayers only.");
        return null;
    }

    /** Whether the sender may run the admin command with node endhost.command.<node>. */
    private boolean can(CommandSender sender, String node) {
        if (!(sender instanceof Player p)) return true; // console always allowed
        if (plugin.ranks().has(p, "endhost.command." + node)) return true;
        msg(sender, "&cYou don't have permission for that.");
        return false;
    }

    private static String arg(String[] args, int i) {
        return i < args.length ? args[i] : null;
    }

    private void msg(CommandSender sender, String legacy) {
        sender.sendMessage(Text.of(legacy));
    }
}
