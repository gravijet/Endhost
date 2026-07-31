package de.endhost.proxy;

import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.proxy.Player;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;

/**
 * {@code /endhostproxy reload} — re-read {@code config.txt} on demand. The plugin already
 * watches the file and picks up panel writes on its own; this is the manual fallback from
 * the proxy console. Players need the {@code endhost.proxy.admin} permission; the console
 * always may.
 */
final class AdminCommand implements SimpleCommand {

    private final EndhostProxy plugin;

    AdminCommand(EndhostProxy plugin) {
        this.plugin = plugin;
    }

    @Override
    public void execute(Invocation invocation) {
        String[] args = invocation.arguments();
        if (args.length >= 1 && args[0].equalsIgnoreCase("reload")) {
            plugin.reload();
            invocation.source().sendMessage(Component.text("EndhostProxy config reloaded.", NamedTextColor.GREEN));
        } else {
            invocation.source().sendMessage(Component.text("Usage: /endhostproxy reload", NamedTextColor.YELLOW));
        }
    }

    @Override
    public boolean hasPermission(Invocation invocation) {
        return !(invocation.source() instanceof Player player) || player.hasPermission("endhost.proxy.admin");
    }
}
