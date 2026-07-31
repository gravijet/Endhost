package de.endhost.lobby;

import org.bukkit.Material;

/** Turn a panel-supplied material name into a real {@link Material}, falling back safely. */
final class Materials {

    private Materials() {}

    static Material byName(String name, Material fallback) {
        if (name == null || name.isBlank()) return fallback;
        Material m = Material.matchMaterial(name.trim().toUpperCase());
        return m != null ? m : fallback;
    }
}
