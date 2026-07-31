package de.endhost.lobby;

import com.google.common.io.ByteArrayDataOutput;
import com.google.common.io.ByteStreams;
import net.kyori.adventure.title.Title;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Sound;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Endhost's lobby plugin: one owned jar in place of TAB, DeluxeMenus, ItemJoin, LuckPerms,
 * PlaceholderAPI and FastAsyncWorldEdit. It builds and runs the hub — its own generated world,
 * a full rank/permission system synced with the proxy, the tablist, sidebar scoreboard, join
 * items, server selector, spawn, cosmetics (double-jump, launch pads, player-hider) and the
 * admin tool-belt — all driven off panel-written files (config.yml, network.json, ranks.json)
 * and ones it owns (spawn.yml, hub world).
 */
public final class EndhostLobby extends JavaPlugin {

    private static final String BUNGEE_CHANNEL = "BungeeCord";
    static final int SELECTOR_SLOT = 4;
    static final int VISIBILITY_SLOT = 7;

    private final LobbyConfig config = new LobbyConfig();
    private RankModel ranks;
    private PermissionService perms;
    private LobbyWorld world;
    private SpawnStore spawn;
    private NetworkModel network;
    private ScoreboardService scoreboard;
    private SelectorMenu selector;
    private StartBridge startBridge;
    private Visibility visibility;
    private Announcer announcer;

    /** Players who turned on real flight with /fly (as opposed to the double-jump everyone gets). */
    private final Set<UUID> flyMode = ConcurrentHashMap.newKeySet();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        config.reload(getConfig());

        ranks = new RankModel(this);
        ranks.reload();
        perms = new PermissionService(this);

        world = new LobbyWorld(this);
        world.ensure();

        spawn = new SpawnStore(this);
        spawn.load();
        if (!spawn.isSet() && world.spawn() != null) spawn.set(world.spawn());

        network = new NetworkModel(this);
        network.reload();
        scoreboard = new ScoreboardService(this);
        selector = new SelectorMenu(this);
        startBridge = new StartBridge(this);
        startBridge.init();
        visibility = new Visibility(this);
        announcer = new Announcer(this);

        getServer().getMessenger().registerOutgoingPluginChannel(this, BUNGEE_CHANNEL);
        getServer().getPluginManager().registerEvents(new LobbyListener(this), this);
        // Keep the hub static and safe: block every way a non-staff player could change it.
        getServer().getPluginManager().registerEvents(new Protection(this), this);

        CommandRouter router = new CommandRouter(this);
        for (String name : List.of("setspawn", "spawn", "servers", "start", "gm", "gmc", "gms", "gma",
                "gmsp", "fly", "speed", "tp", "tphere", "broadcast", "heal", "feed", "day", "night",
                "lobbyreload", "vanish", "clearchat", "rank", "players", "help", "ehhelp")) {
            if (getCommand(name) != null) getCommand(name).setExecutor(router);
        }

        // One heartbeat drives the live bits: pick up panel writes to network.json and ranks.json,
        // refresh every player's board, deliver start-bridge replies, and rescue anyone in the void.
        Bukkit.getScheduler().runTaskTimer(this, () -> {
            network.reloadIfChanged();
            if (ranks.reloadIfChanged()) {
                perms.applyAll();
                scoreboard.resyncRanks();
                visibility.refreshAll();
            }
            scoreboard.tick();
            startBridge.tick();
            voidRescue();
        }, 40L, 20L);

        // The rotating hub tips.
        Bukkit.getScheduler().runTaskTimer(this, () -> announcer.broadcastNext(), 1200L, 1200L);

        // Board, items and permissions for anyone already on (a /reload during testing).
        for (Player p : Bukkit.getOnlinePlayers()) {
            perms.apply(p);
            giveItems(p);
            scoreboard.onJoin(p);
        }
        getLogger().info("EndhostLobby enabled — hub world + ranks ready.");
    }

    private void voidRescue() {
        Location s = spawn.get();
        if (s == null) return;
        for (Player p : Bukkit.getOnlinePlayers()) {
            if (p.getLocation().getY() < 0) p.teleport(s);
        }
    }

    /** The welcome shown to a player as they land in the hub. */
    void welcome(Player player) {
        player.showTitle(Title.title(
                Text.of("&b&lGRAVIJET"),
                Text.of("&7welcome to the hub"),
                Title.Times.times(Duration.ofMillis(300), Duration.ofMillis(1800), Duration.ofMillis(500))));
        player.playSound(player.getLocation(), Sound.ENTITY_PLAYER_LEVELUP, 0.5f, 1.5f);
    }

    /** Send a player to a network server through Velocity's BungeeCord Connect channel. */
    void connectTo(Player player, String serverKey, String displayName) {
        ByteArrayDataOutput out = ByteStreams.newDataOutput();
        out.writeUTF("Connect");
        out.writeUTF(serverKey);
        player.sendPluginMessage(this, BUNGEE_CHANNEL, out.toByteArray());
        player.sendMessage(Text.of("&7Connecting to &a" + displayName + "&7…"));
    }

    /** Give the fixed lobby hotbar: a selector compass and a player-visibility toggle. */
    void giveItems(Player player) {
        player.getInventory().clear();
        ItemStack compass = named(Material.COMPASS, "&b&lServer Selector &7(right-click)",
                "&7Browse and join the network's servers.");
        player.getInventory().setItem(SELECTOR_SLOT, compass);
        updateVisibilityItem(player);
        player.getInventory().setHeldItemSlot(SELECTOR_SLOT);
    }

    /** Refresh the player-visibility toggle item to match the player's current choice. */
    void updateVisibilityItem(Player player) {
        boolean hiding = visibility.isHidingOthers(player);
        ItemStack item = hiding
                ? named(Material.GRAY_DYE, "&7&lPlayers: Hidden", "&7Right-click to show players")
                : named(Material.LIME_DYE, "&a&lPlayers: Shown", "&7Right-click to hide players");
        player.getInventory().setItem(VISIBILITY_SLOT, item);
    }

    private ItemStack named(Material mat, String name, String lore) {
        ItemStack it = new ItemStack(mat);
        ItemMeta meta = it.getItemMeta();
        if (meta != null) {
            meta.displayName(Text.of(name));
            meta.lore(List.of(Text.of(lore)));
            it.setItemMeta(meta);
        }
        return it;
    }

    void reloadAll() {
        reloadConfig();
        config.reload(getConfig());
        spawn.load();
        network.reload();
        ranks.reload();
        perms.applyAll();
        scoreboard.resyncRanks();
        visibility.refreshAll();
    }

    Set<UUID> flyMode() { return flyMode; }

    LobbyConfig config() { return config; }
    RankModel ranks() { return ranks; }
    PermissionService perms() { return perms; }
    LobbyWorld hub() { return world; }
    SpawnStore spawn() { return spawn; }
    NetworkModel network() { return network; }
    ScoreboardService scoreboard() { return scoreboard; }
    SelectorMenu selector() { return selector; }
    StartBridge startBridge() { return startBridge; }
    Visibility visibility() { return visibility; }
    Announcer announcer() { return announcer; }
}
