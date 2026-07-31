package de.endhost.lobby;

import io.papermc.paper.event.player.AsyncChatEvent;
import io.papermc.paper.event.player.AsyncPlayerSpawnLocationEvent;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Particle;
import org.bukkit.Sound;
import org.bukkit.block.Block;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.FoodLevelChangeEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerToggleFlightEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.util.Vector;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Everything the lobby does in response to a player: land them in the hub, hand out the join
 * items, keep the place unbreakable and damage-free, prefix chat with the rank, run the
 * cosmetics (double-jump and slime launch pads), and route selector clicks. Staff (anyone with
 * the {@code endhost.build} node) are exempt from the build and inventory locks.
 */
final class LobbyListener implements Listener {

    private final EndhostLobby plugin;
    private final Map<UUID, Long> padCooldown = new ConcurrentHashMap<>();

    LobbyListener(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    // Land players in the hub from the very first spawn, so they never touch the void primary world.
    @EventHandler
    public void onSpawnLocation(AsyncPlayerSpawnLocationEvent event) {
        Location spawn = plugin.spawn().get();
        if (spawn != null) event.setSpawnLocation(spawn);
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        Player p = event.getPlayer();
        event.joinMessage(Text.of("&8[&a+&8] &7" + p.getName()));
        plugin.perms().apply(p);
        if (!plugin.ranks().isStaff(p)) p.setGameMode(GameMode.ADVENTURE);
        Location spawn = plugin.spawn().get();
        if (spawn != null) p.teleport(spawn);
        p.setAllowFlight(true); // enables the double-jump; real /fly is tracked separately
        p.setFlying(false);
        plugin.giveItems(p);
        plugin.scoreboard().onJoin(p);
        plugin.visibility().refreshAll();
        plugin.welcome(p);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        Player p = event.getPlayer();
        event.quitMessage(Text.of("&8[&c-&8] &7" + p.getName()));
        plugin.scoreboard().onQuit(p);
        plugin.perms().clear(p);
        plugin.flyMode().remove(p.getUniqueId());
        plugin.visibility().onQuit(p);
        plugin.visibility().refreshAll();
        padCooldown.remove(p.getUniqueId());
    }

    @EventHandler
    public void onChat(AsyncChatEvent event) {
        String prefix = plugin.ranks().prefixOf(event.getPlayer());
        event.renderer((source, displayName, message, viewer) ->
                Text.of(prefix + "&f" + source.getName() + " &7» &f").append(message));
    }

    @EventHandler
    public void onRespawn(PlayerRespawnEvent event) {
        Location spawn = plugin.spawn().get();
        if (spawn != null) event.setRespawnLocation(spawn);
    }

    @EventHandler
    public void onDamage(EntityDamageEvent event) {
        if (event.getEntity() instanceof Player) event.setCancelled(true);
    }

    @EventHandler
    public void onHunger(FoodLevelChangeEvent event) {
        if (event.getEntity() instanceof Player p) {
            event.setCancelled(true);
            p.setFoodLevel(20);
            p.setSaturation(20f);
        }
    }

    @EventHandler
    public void onBreak(BlockBreakEvent event) {
        if (!plugin.ranks().isStaff(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler
    public void onPlace(BlockPlaceEvent event) {
        if (!plugin.ranks().isStaff(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler
    public void onDrop(PlayerDropItemEvent event) {
        if (!plugin.ranks().isStaff(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler
    public void onInteract(PlayerInteractEvent event) {
        if (event.getHand() != EquipmentSlot.HAND) return;
        Player player = event.getPlayer();
        ItemStack item = event.getItem();
        if (item != null && item.getType() == Material.COMPASS) {
            event.setCancelled(true);
            plugin.selector().open(player, 0);
            return;
        }
        if (item != null && (item.getType() == Material.LIME_DYE || item.getType() == Material.GRAY_DYE)) {
            event.setCancelled(true);
            boolean hiding = plugin.visibility().toggleHideOthers(player);
            plugin.updateVisibilityItem(player);
            player.sendMessage(Text.of(hiding ? "&7Other players are now &chidden&7." : "&7Other players are now &avisible&7."));
            player.playSound(player.getLocation(), Sound.UI_BUTTON_CLICK, 0.6f, 1.2f);
            return;
        }
        // Stop non-staff opening blocks (beacon, etc.) by right-clicking them.
        if (event.getAction() == Action.RIGHT_CLICK_BLOCK && !plugin.ranks().isStaff(player)) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onInventoryClick(InventoryClickEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) return;
        Inventory top = event.getView().getTopInventory();
        InventoryHolder holder = top.getHolder();
        if (holder instanceof SelectorHolder selector) {
            event.setCancelled(true);
            Inventory clicked = event.getClickedInventory();
            if (clicked != null && clicked.getHolder() instanceof SelectorHolder) {
                plugin.selector().click(player, selector.page(), event.getSlot());
            }
            return;
        }
        // No custom menu open: keep non-staff from rearranging their locked hotbar.
        if (!plugin.ranks().isStaff(player)) event.setCancelled(true);
    }

    // ---- cosmetics: double-jump + slime launch pads ----

    @EventHandler
    public void onToggleFlight(PlayerToggleFlightEvent event) {
        Player p = event.getPlayer();
        if (plugin.flyMode().contains(p.getUniqueId())) return; // real flight from /fly — leave it
        if (!event.isFlying()) return;
        event.setCancelled(true);
        p.setFlying(false);
        p.setAllowFlight(false); // one jump per airtime; restored on landing (onMove)
        Vector v = p.getLocation().getDirection().normalize().multiply(1.25).setY(0.95);
        p.setVelocity(v);
        p.getWorld().spawnParticle(Particle.CLOUD, p.getLocation(), 18, 0.3, 0.1, 0.3, 0.03);
        p.playSound(p.getLocation(), Sound.ENTITY_BAT_TAKEOFF, 0.8f, 1.3f);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onMove(PlayerMoveEvent event) {
        Location from = event.getFrom(), to = event.getTo();
        if (to == null) return;
        if (from.getBlockX() == to.getBlockX() && from.getBlockY() == to.getBlockY() && from.getBlockZ() == to.getBlockZ()) return;
        Player p = event.getPlayer();

        // Restore the double-jump once the player is back on the ground.
        if (p.isOnGround() && !p.getAllowFlight() && !plugin.flyMode().contains(p.getUniqueId())
                && p.getGameMode() != GameMode.CREATIVE && p.getGameMode() != GameMode.SPECTATOR) {
            p.setAllowFlight(true);
        }

        // Slime launch pad: stepping onto a slime block flings the player forward and up.
        Block below = to.clone().subtract(0, 0.2, 0).getBlock();
        if (below.getType() == Material.SLIME_BLOCK) {
            long now = System.currentTimeMillis();
            Long last = padCooldown.get(p.getUniqueId());
            if (last != null && now - last < 500) return;
            padCooldown.put(p.getUniqueId(), now);
            Vector dir = p.getLocation().getDirection().setY(0);
            if (dir.lengthSquared() > 0.0001) dir.normalize().multiply(1.1); else dir.zero();
            dir.setY(1.5);
            p.setVelocity(dir);
            p.getWorld().spawnParticle(Particle.CLOUD, below.getLocation().add(0.5, 1, 0.5), 20, 0.3, 0.1, 0.3, 0.05);
            p.playSound(p.getLocation(), Sound.ENTITY_SLIME_SQUISH, 0.9f, 1.4f);
        }
    }
}
