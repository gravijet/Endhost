package de.endhost.proxy;

import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.util.Map;

/**
 * {@code /start <server>}, {@code /stop <server>}, {@code /restart <server>} — a server owner
 * controls their own server from anywhere on the network. One class, registered three times
 * with the action it carries. Ownership is always re-checked panel-side; this just relays the
 * request, so an unlinked player is told to link first (by the panel's reply).
 */
final class ControlCommand implements SimpleCommand {

    private final ControlBridge bridge;
    private final String action; // start | stop | restart

    ControlCommand(ControlBridge bridge, String action) {
        this.bridge = bridge;
        this.action = action;
    }

    @Override
    public void execute(Invocation invocation) {
        if (!(invocation.source() instanceof Player player)) {
            invocation.source().sendMessage(Component.text("Only players can do that.", NamedTextColor.RED));
            return;
        }
        String[] args = invocation.arguments();
        if (args.length < 1 || args[0].isBlank()) {
            player.sendMessage(Component.text("Usage: /" + action + " <server>", NamedTextColor.YELLOW));
            player.sendMessage(Component.text("See /myservers for the names you can use.", NamedTextColor.GRAY));
            return;
        }
        bridge.submit(player, action, Map.of("server", args[0].trim().toLowerCase()),
                "Sending your " + action + " request for " + args[0].trim() + "…");
    }
}
