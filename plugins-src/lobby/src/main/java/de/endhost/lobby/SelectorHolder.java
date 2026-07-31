package de.endhost.lobby;

import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;

/** Marks an inventory as our server selector and remembers which page it is showing. */
final class SelectorHolder implements InventoryHolder {

    private final int page;
    private Inventory inventory;

    SelectorHolder(int page) {
        this.page = page;
    }

    int page() {
        return page;
    }

    void setInventory(Inventory inventory) {
        this.inventory = inventory;
    }

    @Override
    public Inventory getInventory() {
        return inventory;
    }
}
