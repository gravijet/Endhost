package de.endhost.lobby;

import org.bukkit.Bukkit;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.WorldCreator;
import org.bukkit.block.Block;
import org.bukkit.block.data.type.Leaves;
import org.bukkit.entity.ArmorStand;
import org.bukkit.entity.EntityType;
import org.bukkit.plugin.Plugin;

import java.io.File;

/**
 * The hub world — a fresh, code-owned void world named {@code hub} with a spawn plaza built
 * block by block: a smooth-quartz disc ringed with accent bands and a low sea-lantern wall, a
 * central beacon podium that fires a beam into the sky, four slime launch pads, lampposts,
 * trees, four archway entrances, and floating hologram text overhead. Nothing is downloaded and
 * the old primary world is never touched — this is the "new lobby world" as its own place.
 *
 * <p>The plaza is laid once (guarded by a marker file) so a restart never rebuilds it; the
 * holograms are entities, so they are cleared by tag and respawned on every enable to stay
 * exactly right. The launch pads are just slime blocks the movement listener reacts to.
 */
final class LobbyWorld {

    static final String NAME = "hub";
    static final int FLOOR_Y = 64;          // top of the plaza floor; players stand at FLOOR_Y + 1
    static final int RADIUS = 22;           // plaza radius
    static final String HOLO_TAG = "eh_holo";

    private final Plugin plugin;
    private World world;

    LobbyWorld(Plugin plugin) {
        this.plugin = plugin;
    }

    World world() {
        return world;
    }

    /** The default hub spawn: just south of the beacon, looking north across the plaza at it. */
    Location spawn() {
        World w = world != null ? world : Bukkit.getWorld(NAME);
        if (w == null) return null;
        return new Location(w, 0.5, FLOOR_Y + 1, 9.5, 180f, 0f);
    }

    /** Create/load the hub world, build the plaza once, and (re)place the holograms. */
    void ensure() {
        world = Bukkit.getWorld(NAME);
        if (world == null) {
            WorldCreator wc = new WorldCreator(NAME);
            wc.generator(new VoidGenerator());
            wc.generateStructures(false);
            wc.environment(World.Environment.NORMAL);
            world = wc.createWorld();
        }
        if (world == null) {
            plugin.getLogger().warning("Could not create the hub world; falling back to the primary world.");
            return;
        }
        world.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, false);
        world.setGameRule(GameRule.DO_WEATHER_CYCLE, false);
        world.setGameRule(GameRule.DO_MOB_SPAWNING, false);
        world.setGameRule(GameRule.FALL_DAMAGE, false);
        world.setGameRule(GameRule.DO_FIRE_TICK, false);
        world.setGameRule(GameRule.ANNOUNCE_ADVANCEMENTS, false);
        world.setTime(6000);
        world.setStorm(false);
        world.setDifficulty(org.bukkit.Difficulty.PEACEFUL);
        world.setSpawnLocation(0, FLOOR_Y + 1, 9);

        File marker = new File(plugin.getDataFolder(), "hub.built");
        if (!marker.exists()) {
            plugin.getLogger().info("Building the hub plaza…");
            buildPlaza();
            try { marker.getParentFile().mkdirs(); marker.createNewFile(); }
            catch (Exception e) { plugin.getLogger().warning("Could not write hub marker: " + e.getMessage()); }
            plugin.getLogger().info("Hub plaza built.");
        }
        refreshHolograms();
    }

    // -------------------------------------------------------------- the build

    private void buildPlaza() {
        // Floor disc: smooth quartz base with two light-blue accent rings, a darker rim, and
        // four polished-diorite spoke paths out to the arches.
        for (int x = -RADIUS - 2; x <= RADIUS + 2; x++) {
            for (int z = -RADIUS - 2; z <= RADIUS + 2; z++) {
                double d = Math.sqrt(x * (double) x + z * (double) z);
                if (d > RADIUS + 0.5) continue;
                Material mat = Material.SMOOTH_QUARTZ;
                boolean path = (Math.abs(x) <= 1 || Math.abs(z) <= 1);
                if (d >= RADIUS - 0.5) mat = Material.GRAY_CONCRETE;                 // rim
                else if (near(d, 11) || near(d, 17)) mat = Material.LIGHT_BLUE_CONCRETE; // accent rings
                else if (path && d > 6) mat = Material.POLISHED_DIORITE;            // spoke paths
                set(x, FLOOR_Y, z, mat);
                // Clear the two blocks above the floor so nothing stray remains.
                set(x, FLOOR_Y + 1, z, Material.AIR);
                set(x, FLOOR_Y + 2, z, Material.AIR);
            }
        }

        // Outer wall: two-high smooth stone at the rim, with sea-lantern posts every 45°, and
        // a gap on each spoke so the four archways read as entrances.
        for (int a = 0; a < 360; a += 2) {
            double rad = Math.toRadians(a);
            int x = (int) Math.round(Math.cos(rad) * RADIUS);
            int z = (int) Math.round(Math.sin(rad) * RADIUS);
            if (Math.abs(x) <= 1 || Math.abs(z) <= 1) continue; // leave the four path openings
            set(x, FLOOR_Y + 1, z, Material.SMOOTH_STONE);
            set(x, FLOOR_Y + 2, z, Material.SMOOTH_STONE_SLAB);
        }
        // Sea-lantern rim posts + arches on the four spokes.
        int[][] dirs = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (int[] dxz : dirs) {
            int ex = dxz[0] * RADIUS, ez = dxz[1] * RADIUS;
            // Arch pillars flanking the opening.
            for (int side = -2; side <= 2; side += 4) {
                int px = ex + dxz[1] * side, pz = ez + dxz[0] * side;
                pillar(px, pz, FLOOR_Y + 1, FLOOR_Y + 4, Material.QUARTZ_PILLAR);
                set(px, FLOOR_Y + 5, pz, Material.SEA_LANTERN);
            }
            // Arch lintel across the top.
            for (int side = -2; side <= 2; side++) {
                int lx = ex + dxz[1] * side, lz = ez + dxz[0] * side;
                set(lx, FLOOR_Y + 5, lz, Material.SMOOTH_QUARTZ);
            }
        }

        // Eight lampposts on a ring inside the wall.
        for (int a = 0; a < 360; a += 45) {
            double rad = Math.toRadians(a + 22.5);
            int x = (int) Math.round(Math.cos(rad) * 18);
            int z = (int) Math.round(Math.sin(rad) * 18);
            pillar(x, z, FLOOR_Y + 1, FLOOR_Y + 3, Material.POLISHED_BLACKSTONE_WALL);
            set(x, FLOOR_Y + 4, z, Material.SEA_LANTERN);
            set(x, FLOOR_Y + 5, z, Material.LANTERN);
        }

        // Central podium: a raised chiselled-quartz disc with a quartz kerb.
        for (int x = -6; x <= 6; x++) {
            for (int z = -6; z <= 6; z++) {
                double d = Math.sqrt(x * (double) x + z * (double) z);
                if (d <= 5.5) set(x, FLOOR_Y + 1, z, Material.CHISELED_QUARTZ_BLOCK);
                if (near(d, 6)) set(x, FLOOR_Y + 1, z, Material.QUARTZ_PILLAR);
            }
        }
        // Beacon centrepiece: a 3×3 diamond base with sea-lantern corners, beacon on top → beam.
        for (int x = -1; x <= 1; x++)
            for (int z = -1; z <= 1; z++)
                set(x, FLOOR_Y + 2, z, Material.DIAMOND_BLOCK);
        for (int[] c : new int[][]{{2, 2}, {2, -2}, {-2, 2}, {-2, -2}})
            set(c[0], FLOOR_Y + 2, c[1], Material.SEA_LANTERN);
        set(0, FLOOR_Y + 3, 0, Material.BEACON);

        // Four slime launch pads at the cardinal points, framed in lime for visibility.
        for (int[] dxz : dirs) {
            int cx = dxz[0] * 10, cz = dxz[1] * 10;
            for (int x = -1; x <= 1; x++)
                for (int z = -1; z <= 1; z++)
                    set(cx + x, FLOOR_Y, cz + z, Material.LIME_CONCRETE);
            set(cx, FLOOR_Y, cz, Material.SLIME_BLOCK);
        }

        // Four little trees on the diagonals for a bit of green.
        for (int[] dxz : new int[][]{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}}) {
            tree(dxz[0] * 14, dxz[1] * 14);
        }
    }

    private void tree(int x, int z) {
        pillar(x, z, FLOOR_Y + 1, FLOOR_Y + 4, Material.OAK_LOG);
        for (int dy = 3; dy <= 5; dy++) {
            int r = dy == 4 ? 2 : 1;
            for (int lx = -r; lx <= r; lx++)
                for (int lz = -r; lz <= r; lz++) {
                    if (lx == 0 && lz == 0 && dy <= 4) continue;
                    if (Math.abs(lx) == r && Math.abs(lz) == r) continue;
                    leaf(x + lx, FLOOR_Y + dy, z + lz);
                }
        }
    }

    private void leaf(int x, int y, int z) {
        Block b = world.getBlockAt(x, y, z);
        if (b.getType() != Material.AIR) return;
        Leaves data = (Leaves) Material.OAK_LEAVES.createBlockData();
        data.setPersistent(true);
        b.setBlockData(data, false);
    }

    // ------------------------------------------------------------ holograms

    /** Remove any tagged hologram stands, then float a fresh welcome stack above the beacon. */
    void refreshHolograms() {
        if (world == null) return;
        for (org.bukkit.entity.Entity e : world.getEntities()) {
            if (e.getScoreboardTags().contains(HOLO_TAG)) e.remove();
        }
        String[] lines = {
                "&b&lGRAVIJET NETWORK",
                "&7Welcome to the hub",
                "&eRight-click your compass to play",
        };
        double y = FLOOR_Y + 6.2;
        for (String line : lines) {
            hologram(new Location(world, 0.5, y, 0.5), line);
            y -= 0.3;
        }
    }

    private void hologram(Location loc, String legacy) {
        ArmorStand stand = (ArmorStand) world.spawnEntity(loc, EntityType.ARMOR_STAND);
        stand.setVisible(false);
        stand.setGravity(false);
        stand.setMarker(true);
        stand.setSmall(true);
        stand.setBasePlate(false);
        stand.setCustomNameVisible(true);
        stand.customName(Text.of(legacy));
        stand.setInvulnerable(true);
        stand.addScoreboardTag(HOLO_TAG);
    }

    // -------------------------------------------------------------- helpers

    private static boolean near(double d, double target) {
        return Math.abs(d - target) < 0.6;
    }

    private void set(int x, int y, int z, Material m) {
        world.getBlockAt(x, y, z).setType(m, false);
    }

    private void pillar(int x, int z, int y0, int y1, Material m) {
        for (int y = y0; y <= y1; y++) set(x, y, z, m);
    }
}
