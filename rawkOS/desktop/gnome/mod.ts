import { runCommand } from "../../utils/commands/mod.ts";
import { dconfImport } from "../../utils/dconf/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await dconfImport(`${import.meta.dirname}/gnome.dconf`);
await dconfImport(`${import.meta.dirname}/keybindings.dconf`);

ensureHomeSymlink(
  `${import.meta.dirname}/bookmarks`,
  ".config/gtk-3.0/bookmarks",
);

archInstall(["gnome-extensions-cli"]);

runCommand("gext", ["install", "advanced-alt-tab@G-dH.github.com"]);
await dconfImport(`${import.meta.dirname}/advanced-alt-tab.dconf`);

runCommand("gext", ["install", "blur-my-shell@aunetx"]);

runCommand("gext", ["install", "burn-my-windows@schneegans.github.com"]);
await dconfImport(`${import.meta.dirname}/burn-my-windows.dconf`);
ensureHomeSymlink(
  `${import.meta.dirname}/burn-my-windows.conf`,
  ".config/burn-my-windows/profiles/focus.conf",
);

runCommand("gext", ["install", "caffeine@patapon.info"]);
runCommand("gext", ["install", "clipboard-indicator@tudmotu.com"]);

runCommand("gext", ["install", "compiz-windows-effect@hermes83.github.com"]);
runCommand("gext", ["install", "desktop-cube@schneegans.github.com"]);

runCommand("gext", ["install", "emoji-copy@felipeftn"]);

runCommand("gext", ["install", "gsconnect@andyholmes.github.io"]);

runCommand("gext", ["install", "just-perfection-desktop@just-perfection"]);

runCommand("gext", ["install", "transparent-window-moving@noobsai.github.com"]);

runCommand("gext", ["install", "useless-gaps@pimsnel.com"]);
