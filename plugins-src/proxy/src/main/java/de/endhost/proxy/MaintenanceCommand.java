package de.endhost.proxy;

import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.util.Map;

/**
 * {@code /maintenance [on|off]} — staff toggle for network maintenance: turns the server-list
 * MOTD to the maintenance one and turns away anyone not whitelisted (staff still get in). With
 * no argument it flips the current state. The panel is the source of truth, so this relays the
 * change through the control bridge; the proxy picks the new state up from config.txt within a
 * couple of seconds. Requires the {@code endhost.staff} permission.
 */
final class MaintenanceCommand implements SimpleCommand {

    private final ControlBridge bridge;
    private final EndhostProxy plugin;

    MaintenanceCommand(ControlBridge bridge, EndhostProxy plugin) {
        this.bridge = bridge;
        this.plugin = plugin;
    }

    @Override
    public void execute(Invocation invocation) {
        if (!(invocation.source() instanceof Player player)) {
            invocation.source().sendMessage(Component.text("Only players can use /maintenance.", NamedTextColor.RED));
            return;
        }
        String[] args = invocation.arguments();
        String value;
        if (args.length >= 1 && !args[0].isBlank()) {
            value = args[0].trim().toLowerCase();
            if (!value.equals("on") && !value.equals("off")) {
                player.sendMessage(Component.text("Usage: /maintenance [on|off]", NamedTextColor.YELLOW));
                return;
            }
        } else {
            // No argument: flip whatever the proxy currently believes is in effect.
            value = plugin.isMaintenance() ? "off" : "on";
        }
        bridge.submit(player, "maintenance", Map.of("value", value), "Setting maintenance " + value + "…");
    }

    @Override
    public boolean hasPermission(Invocation invocation) {
        return !(invocation.source() instanceof Player player) || player.hasPermission("endhost.staff");
    }
}
