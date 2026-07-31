package de.endhost.proxy;

import com.google.inject.Inject;
import com.velocitypowered.api.command.CommandManager;
import com.velocitypowered.api.command.CommandMeta;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.event.ResultedEvent;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.LoginEvent;
import com.velocitypowered.api.event.permission.PermissionsSetupEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyPingEvent;
import com.velocitypowered.api.permission.Tristate;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.plugin.annotation.DataDirectory;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.ServerPing;
import net.kyori.adventure.text.Component;
import org.slf4j.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * Endhost's network proxy plugin. One owned jar in place of a pile of third-party proxy
 * add-ons: it serves the server-list MOTD (a normal one and a maintenance one, switched by
 * the panel), gates logins against a whitelist while maintenance is on, and gives players
 * {@code /hub}, {@code /l} and {@code /lobby} to get back to the lobby.
 *
 * <p>All state comes from {@code config.txt}, written by the panel into this plugin's data
 * directory and re-read whenever it changes — the panel never has to restart the proxy to
 * flip maintenance or edit the MOTD.
 */
@Plugin(id = "endhostproxy", name = "EndhostProxy", version = "1.0.0",
        description = "Endhost network proxy: lobby commands, MOTD and maintenance.",
        authors = {"Endhost"})
public final class EndhostProxy {

    /** The Velocity server key the lobby is always registered under (see network.ts). */
    static final String LOBBY = "lobby";

    private final ProxyServer server;
    private final Logger logger;
    private final Path configFile;
    private final Path ranksFile;
    private final ControlBridge control;

    private volatile NetworkConfig config = NetworkConfig.defaults();
    private volatile RankConfig ranks = RankConfig.empty();
    private volatile long lastModified = -1;
    private volatile long ranksModified = -1;

    @Inject
    public EndhostProxy(ProxyServer server, Logger logger, @DataDirectory Path dataDirectory) {
        this.server = server;
        this.logger = logger;
        this.configFile = dataDirectory.resolve("config.txt");
        this.ranksFile = dataDirectory.resolve("ranks.txt");
        this.control = new ControlBridge(server, logger, dataDirectory);
    }

    /** Whether network maintenance is currently in effect (used by {@code /maintenance} with no argument). */
    boolean isMaintenance() {
        return config.maintenance;
    }

    @Subscribe
    public void onInit(ProxyInitializeEvent event) {
        reload();
        control.init();
        // Watch config.txt for panel writes and re-read on change — no restart needed.
        server.getScheduler().buildTask(this, this::reloadIfChanged)
                .repeat(2, TimeUnit.SECONDS)
                .schedule();
        // Poll the control bridge for panel replies to /link, /start·/stop·/restart, /maintenance.
        server.getScheduler().buildTask(this, control::tick)
                .repeat(1, TimeUnit.SECONDS)
                .schedule();

        CommandManager commands = server.getCommandManager();
        register(commands, new LobbyCommand(server), "hub", "l", "lobby");
        register(commands, new AdminCommand(this), "endhostproxy");
        // Owner server control from anywhere on the network (ownership re-checked panel-side).
        register(commands, new LinkCommand(control), "link");
        register(commands, new ServersCommand(control), "myservers", "servers");
        register(commands, new ControlCommand(control, "start"), "start");
        register(commands, new ControlCommand(control, "stop"), "stop");
        register(commands, new ControlCommand(control, "restart"), "restart");
        register(commands, new MaintenanceCommand(control, this), "maintenance");

        logger.info("EndhostProxy enabled — maintenance={}", config.maintenance);
    }

    private void register(CommandManager commands, SimpleCommand command, String name, String... aliases) {
        CommandMeta meta = commands.metaBuilder(name).aliases(aliases).plugin(this).build();
        commands.register(meta, command);
    }

    /** Serve the active MOTD (normal or maintenance) on the server-list ping. */
    @Subscribe
    public void onPing(ProxyPingEvent event) {
        NetworkConfig c = config;
        Component description = c.maintenance ? c.motdMaintenance : c.motdNormal;
        ServerPing ping = event.getPing().asBuilder().description(description).build();
        event.setPing(ping);
    }

    /** Give every player the permission nodes their rank grants, so Velocity's own checks
     *  (and {@code /endhostproxy}) respect the same ranks the lobby does. */
    @Subscribe
    public void onPermissionsSetup(PermissionsSetupEvent event) {
        if (!(event.getSubject() instanceof Player player)) return;
        String name = player.getUsername();
        String uuid = player.getUniqueId().toString();
        event.setProvider(subject -> node -> ranks.has(name, uuid, node) ? Tristate.TRUE : Tristate.UNDEFINED);
    }

    /** While maintenance is on, only whitelisted players and staff get in. */
    @Subscribe
    public void onLogin(LoginEvent event) {
        NetworkConfig c = config;
        if (!c.maintenance) return;
        Player player = event.getPlayer();
        String name = player.getUsername();
        String uuid = player.getUniqueId().toString();
        if (c.allows(name, uuid)) return;
        if (ranks.has(name, uuid, "endhost.staff")) return; // staff bypass maintenance
        event.setResult(ResultedEvent.ComponentResult.denied(c.kick));
    }

    /** Force a re-read of config.txt and ranks.txt. Package-private so {@link AdminCommand} can call it. */
    void reload() {
        try {
            config = NetworkConfig.load(configFile);
            lastModified = Files.exists(configFile) ? Files.getLastModifiedTime(configFile).toMillis() : -1;
        } catch (Exception e) {
            logger.warn("Could not read {} ({}); keeping defaults.", configFile, e.getMessage());
            config = NetworkConfig.defaults();
            lastModified = -1;
        }
        try {
            ranks = RankConfig.load(ranksFile);
            ranksModified = Files.exists(ranksFile) ? Files.getLastModifiedTime(ranksFile).toMillis() : -1;
        } catch (Exception e) {
            logger.warn("Could not read {} ({}); keeping empty ranks.", ranksFile, e.getMessage());
            ranks = RankConfig.empty();
            ranksModified = -1;
        }
    }

    private void reloadIfChanged() {
        try {
            long m = Files.exists(configFile) ? Files.getLastModifiedTime(configFile).toMillis() : -1;
            long rm = Files.exists(ranksFile) ? Files.getLastModifiedTime(ranksFile).toMillis() : -1;
            if (m != lastModified || rm != ranksModified) reload();
        } catch (Exception ignored) {
            /* transient fs hiccup — try again next tick */
        }
    }
}
