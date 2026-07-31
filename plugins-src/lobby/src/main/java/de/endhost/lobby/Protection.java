package de.endhost.lobby;

import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBurnEvent;
import org.bukkit.event.block.BlockDispenseEvent;
import org.bukkit.event.block.BlockFadeEvent;
import org.bukkit.event.block.BlockFormEvent;
import org.bukkit.event.block.BlockFromToEvent;
import org.bukkit.event.block.BlockGrowEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockPhysicsEvent;
import org.bukkit.event.block.BlockSpreadEvent;
import org.bukkit.event.block.EntityBlockFormEvent;
import org.bukkit.event.block.LeavesDecayEvent;
import org.bukkit.event.entity.CreatureSpawnEvent;
import org.bukkit.event.entity.EntityChangeBlockEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.hanging.HangingBreakByEntityEvent;
import org.bukkit.event.hanging.HangingBreakEvent;
import org.bukkit.event.hanging.HangingPlaceEvent;
import org.bukkit.event.player.PlayerArmorStandManipulateEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerBucketFillEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.weather.WeatherChangeEvent;

/**
 * Build protection for the hub. The lobby is a shared, static space: nobody who isn't staff may
 * change a single block, entity or item in it, and the world itself never weathers, grows,
 * burns, floods or spawns mobs on its own. Staff (anyone with {@code endhost.build}) are exempt
 * from the player-driven rules so they can still build and fix the place. The pure-environment
 * rules (fire spread, liquid flow, leaf decay, weather, natural spawns) are cancelled outright —
 * there is no legitimate source for them here.
 *
 * <p>Block break/place/drop and generic entity damage are handled in {@link LobbyListener}; this
 * closes every remaining door: buckets, item frames and paintings, armour stands, mob spawns,
 * explosions, fire, liquids, physics-driven decay and item pickup.
 */
final class Protection implements Listener {

    private final EndhostLobby plugin;

    Protection(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    private boolean staff(Player p) {
        return plugin.ranks().isStaff(p);
    }

    // ---- player-driven changes (staff may still do them) ----

    @EventHandler(ignoreCancelled = true)
    public void onBucketEmpty(PlayerBucketEmptyEvent e) {
        if (!staff(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onBucketFill(PlayerBucketFillEvent e) {
        if (!staff(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onHangingPlace(HangingPlaceEvent e) {
        Player p = e.getPlayer();
        if (p != null && !staff(p)) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onHangingBreakByEntity(HangingBreakByEntityEvent e) {
        Entity remover = e.getRemover();
        if (remover instanceof Player p) { if (!staff(p)) e.setCancelled(true); }
        else e.setCancelled(true); // a mob, projectile or explosion — never allowed
    }

    @EventHandler(ignoreCancelled = true)
    public void onHangingBreak(HangingBreakEvent e) {
        // Physics/obstruction breaks of item frames and paintings (not covered above).
        if (e.getCause() != HangingBreakEvent.RemoveCause.ENTITY) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onArmorStand(PlayerArmorStandManipulateEvent e) {
        if (!staff(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onInteractEntity(PlayerInteractEntityEvent e) {
        if (!staff(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onEntityDamageByEntity(EntityDamageByEntityEvent e) {
        // Protect holograms, item frames and armour stands from being punched by non-staff.
        if (e.getDamager() instanceof Player p && !staff(p)) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onPickup(EntityPickupItemEvent e) {
        if (e.getEntity() instanceof Player p && !staff(p)) e.setCancelled(true);
    }

    // ---- pure-environment changes (never allowed in the hub) ----

    @EventHandler(ignoreCancelled = true)
    public void onFromTo(BlockFromToEvent e) { e.setCancelled(true); }        // liquid flow, dragon egg

    @EventHandler(ignoreCancelled = true)
    public void onBurn(BlockBurnEvent e) { e.setCancelled(true); }

    @EventHandler(ignoreCancelled = true)
    public void onFade(BlockFadeEvent e) { e.setCancelled(true); }            // ice/snow/fire dying

    @EventHandler(ignoreCancelled = true)
    public void onForm(BlockFormEvent e) { e.setCancelled(true); }            // snow/ice forming

    @EventHandler(ignoreCancelled = true)
    public void onEntityBlockForm(EntityBlockFormEvent e) { e.setCancelled(true); } // frost walker etc.

    @EventHandler(ignoreCancelled = true)
    public void onSpread(BlockSpreadEvent e) { e.setCancelled(true); }        // grass/fire/mushroom spread

    @EventHandler(ignoreCancelled = true)
    public void onGrow(BlockGrowEvent e) { e.setCancelled(true); }            // crops, saplings

    @EventHandler(ignoreCancelled = true)
    public void onLeafDecay(LeavesDecayEvent e) { e.setCancelled(true); }

    @EventHandler(ignoreCancelled = true)
    public void onIgnite(BlockIgniteEvent e) { e.setCancelled(true); }

    @EventHandler(ignoreCancelled = true)
    public void onEntityExplode(EntityExplodeEvent e) { e.setCancelled(true); }

    @EventHandler(ignoreCancelled = true)
    public void onEntityChangeBlock(EntityChangeBlockEvent e) { e.setCancelled(true); } // endermen, falling blocks, sheep

    @EventHandler(ignoreCancelled = true)
    public void onDispense(BlockDispenseEvent e) { e.setCancelled(true); }

    @EventHandler
    public void onWeather(WeatherChangeEvent e) {
        if (e.toWeatherState()) e.setCancelled(true); // never let it start raining
    }

    @EventHandler(ignoreCancelled = true)
    public void onSpawn(CreatureSpawnEvent e) {
        // Allow only deliberate spawns (the hologram armour stands, or a plugin/command); block
        // everything natural so no mob ever appears in the hub.
        switch (e.getSpawnReason()) {
            case CUSTOM, COMMAND, DEFAULT -> { /* our own hologram/decor spawns */ }
            default -> e.setCancelled(true);
        }
    }

    // Physics can still knock loose "floating" decorative blocks; keep them put.
    @EventHandler(ignoreCancelled = true)
    public void onPhysics(BlockPhysicsEvent e) {
        switch (e.getChangedType()) {
            case SAND, RED_SAND, GRAVEL -> e.setCancelled(true);
            default -> { /* leave normal redstone/physics alone */ }
        }
    }
}
