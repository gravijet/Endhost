package de.endhost.proxy;

import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.util.Map;

/**
 * {@code /link <code>} — bind this Minecraft account to an Endhost panel account. The player
 * gets a one-time code on their Account page at example.invalid and types it here; once linked they
 * can control their own servers in-game with {@code /start}, {@code /stop} and {@code /restart}.
 */
final class LinkCommand implements SimpleCommand {

    private final ControlBridge bridge;

    LinkCommand(ControlBridge bridge) {
        this.bridge = bridge;
    }

    @Override
    public void execute(Invocation invocation) {
        if (!(invocation.source() instanceof Player player)) {
            invocation.source().sendMessage(Component.text("Only players can link an account.", NamedTextColor.RED));
            return;
        }
        String[] args = invocation.arguments();
        if (args.length < 1 || args[0].isBlank()) {
            player.sendMessage(Component.text("Usage: /link <code>", NamedTextColor.YELLOW));
            player.sendMessage(Component.text("Get your code on the Account page at example.invalid.", NamedTextColor.GRAY));
            return;
        }
        bridge.submit(player, "link", Map.of("code", args[0].trim()), "Linking your account…");
    }
}
