package de.endhost.proxy;

import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.util.Map;

/**
 * {@code /myservers} — list the servers this linked account owns, with each one's live status,
 * so the player knows the names to pass to {@code /start}, {@code /stop} and {@code /restart}.
 */
final class ServersCommand implements SimpleCommand {

    private final ControlBridge bridge;

    ServersCommand(ControlBridge bridge) {
        this.bridge = bridge;
    }

    @Override
    public void execute(Invocation invocation) {
        if (!(invocation.source() instanceof Player player)) {
            invocation.source().sendMessage(Component.text("Only players can list their servers.", NamedTextColor.RED));
            return;
        }
        bridge.submit(player, "list", Map.of(), "Fetching your servers…");
    }
}
