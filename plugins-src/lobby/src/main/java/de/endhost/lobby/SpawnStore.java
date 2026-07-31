package de.endhost.lobby;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.plugin.Plugin;

import java.io.File;
import java.io.IOException;

/**
 * The lobby spawn, persisted to spawn.yml in the plugin folder. Owned entirely by the
 * plugin (the panel never writes it) so /setspawn survives redeploys. Falls back to the
 * world's own spawn when nothing has been set yet.
 */
final class SpawnStore {

    private final Plugin plugin;
    private final File file;
    private Location spawn;

    SpawnStore(Plugin plugin) {
        this.plugin = plugin;
        this.file = new File(plugin.getDataFolder(), "spawn.yml");
    }

    void load() {
        if (!file.exists()) { spawn = null; return; }
        YamlConfiguration c = YamlConfiguration.loadConfiguration(file);
        String worldName = c.getString("world", LobbyWorld.NAME);
        World world = Bukkit.getWorld(worldName);
        if (world == null) world = fallbackWorld();
        if (world == null) { spawn = null; return; }
        spawn = new Location(world, c.getDouble("x"), c.getDouble("y"), c.getDouble("z"),
                (float) c.getDouble("yaw"), (float) c.getDouble("pitch"));
    }

    /** Whether an explicit spawn has been set (via /setspawn or the hub build). */
    boolean isSet() {
        return spawn != null;
    }

    /** The configured spawn, or the hub world's own spawn if none is set. */
    Location get() {
        if (spawn != null) return spawn.clone();
        World world = fallbackWorld();
        return world != null ? world.getSpawnLocation() : null;
    }

    private static World fallbackWorld() {
        World hub = Bukkit.getWorld(LobbyWorld.NAME);
        if (hub != null) return hub;
        return Bukkit.getWorlds().isEmpty() ? null : Bukkit.getWorlds().get(0);
    }

    void set(Location loc) {
        this.spawn = loc.clone();
        YamlConfiguration c = new YamlConfiguration();
        c.set("world", loc.getWorld().getName());
        c.set("x", loc.getX());
        c.set("y", loc.getY());
        c.set("z", loc.getZ());
        c.set("yaw", (double) loc.getYaw());
        c.set("pitch", (double) loc.getPitch());
        try {
            file.getParentFile().mkdirs();
            c.save(file);
        } catch (IOException e) {
            plugin.getLogger().warning("Could not save spawn.yml: " + e.getMessage());
        }
    }
}
