package de.endhost.proxy;

import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

import java.util.Optional;

/** {@code /hub}, {@code /l}, {@code /lobby} — send the player back to the lobby. */
final class LobbyCommand implements SimpleCommand {

    private final ProxyServer server;

    LobbyCommand(ProxyServer server) {
        this.server = server;
    }

    @Override
    public void execute(Invocation invocation) {
        CommandSource src = invocation.source();
        if (!(src instanceof Player player)) {
            src.sendMessage(Component.text("Only players can go to the lobby.", NamedTextColor.RED));
            return;
        }
        boolean alreadyHere = player.getCurrentServer()
                .map(c -> c.getServerInfo().getName().equals(EndhostProxy.LOBBY))
                .orElse(false);
        if (alreadyHere) {
            player.sendMessage(Component.text("You're already in the lobby.", NamedTextColor.YELLOW));
            return;
        }
        Optional<RegisteredServer> lobby = server.getServer(EndhostProxy.LOBBY);
        if (lobby.isEmpty()) {
            player.sendMessage(Component.text("The lobby is offline right now — try again in a moment.", NamedTextColor.RED));
            return;
        }
        player.sendMessage(Component.text("Sending you to the lobby…", NamedTextColor.AQUA));
        player.createConnectionRequest(lobby.get()).fireAndForget();
    }
}
