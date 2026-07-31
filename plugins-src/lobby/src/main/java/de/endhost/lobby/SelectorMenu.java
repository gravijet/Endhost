package de.endhost.lobby;

import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;

import java.util.ArrayList;
import java.util.List;

/**
 * The in-game server selector: always six rows, every network server shown (the lobby
 * itself is never in the list — the panel excludes it), online ones green and joinable,
 * offline ones grey. The bottom row is navigation — previous-page arrow, close, next-page
 * arrow — so any number of servers pages cleanly.
 */
final class SelectorMenu {

    static final int SIZE = 54;
    static final int PER_PAGE = 45;
    static final int SLOT_PREV = 45;
    static final int SLOT_CLOSE = 49;
    static final int SLOT_NEXT = 53;

    private final EndhostLobby plugin;

    SelectorMenu(EndhostLobby plugin) {
        this.plugin = plugin;
    }

    void open(Player player, int page) {
        List<NetworkModel.Entry> servers = plugin.network().servers();
        int pages = Math.max(1, (int) Math.ceil(servers.size() / (double) PER_PAGE));
        page = Math.max(0, Math.min(page, pages - 1));

        SelectorHolder holder = new SelectorHolder(page);
        Component title = Text.of("&8» &bServer Selector &8(" + (page + 1) + "/" + pages + ")");
        Inventory inv = Bukkit.createInventory(holder, SIZE, title);
        holder.setInventory(inv);

        int start = page * PER_PAGE;
        for (int i = 0; i < PER_PAGE && start + i < servers.size(); i++) {
            inv.setItem(i, icon(servers.get(start + i)));
        }

        ItemStack pane = pane();
        for (int s = PER_PAGE; s < SIZE; s++) inv.setItem(s, pane);
        if (page > 0) inv.setItem(SLOT_PREV, arrow("&aPrevious Page", "&7Go back a page"));
        inv.setItem(SLOT_CLOSE, named(Material.BARRIER, "&cClose", "&7Close this menu"));
        if (page < pages - 1) inv.setItem(SLOT_NEXT, arrow("&aNext Page", "&7Go forward a page"));

        player.openInventory(inv);
    }

    /** Handle a click in an open selector. Returns nothing; drives connect/start/navigation. */
    void click(Player player, int page, int slot) {
        if (slot == SLOT_CLOSE) { player.closeInventory(); return; }
        if (slot == SLOT_PREV) { if (page > 0) open(player, page - 1); return; }
        if (slot == SLOT_NEXT) { open(player, page + 1); return; }
        if (slot < 0 || slot >= PER_PAGE) return;

        List<NetworkModel.Entry> servers = plugin.network().servers();
        int index = page * PER_PAGE + slot;
        if (index >= servers.size()) return;
        NetworkModel.Entry e = servers.get(index);

        if (e.online) {
            player.closeInventory();
            plugin.connectTo(player, e.key, e.name);
        } else if (e.startable) {
            player.closeInventory();
            plugin.startBridge().request(player, e.key);
        } else {
            player.sendMessage(Text.of("&7" + e.name + " is offline. &8Ask an admin to start it."));
        }
    }

    private ItemStack icon(NetworkModel.Entry e) {
        Material mat = Materials.byName(e.material, Material.GRASS_BLOCK);
        String name = e.online ? "&a&l" + e.name : "&7&l" + e.name;
        List<String> lore = new ArrayList<>();
        if (e.online) {
            lore.add("&8Status: &aOnline");
            lore.add(" ");
            lore.add("&eClick to join");
        } else {
            lore.add("&8Status: &cOffline");
            lore.add(" ");
            lore.add(e.startable ? "&eClick to start it" : "&8An admin can start it");
        }
        return named(mat, name, lore.toArray(new String[0]));
    }

    private ItemStack arrow(String name, String lore) {
        return named(Material.ARROW, name, lore);
    }

    private ItemStack pane() {
        return named(Material.GRAY_STAINED_GLASS_PANE, " ");
    }

    private ItemStack named(Material mat, String name, String... lore) {
        ItemStack it = new ItemStack(mat);
        ItemMeta meta = it.getItemMeta();
        if (meta != null) {
            meta.displayName(Text.of(name));
            if (lore.length > 0) {
                List<Component> lines = new ArrayList<>();
                for (String l : lore) lines.add(Text.of(l));
                meta.lore(lines);
            }
            it.setItemMeta(meta);
        }
        return it;
    }
}
