import { runCommand } from "../../utils/commands/mod.ts";
import { dconfImport } from "../../utils/dconf/mod.ts";
import { ensureHomeSymlink } from "../../utils/files/mod.ts";
import { archInstall } from "../../utils/package/mod.ts";

await dconfImport(`${import.meta.dirname}/gnome.dconf`);
await dconfImport(`${import.meta.dirname}/keybindings.dconf`);
await dconfImport(`${import.meta.dirname}/mouse.dconf`);

ensureHomeSymlink(
	`${import.meta.dirname}/bookmarks`,
	".config/gtk-3.0/bookmarks",
	{
		force: true,
	},
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

runCommand("gext", ["install", "appindicatorsupport@rgcjonas.gmail.com"]);

runCommand("gext", ["install", "space-bar@luchrioh"]);

runCommand("gext", ["install", "gsconnect@andyholmes.github.io"]);

runCommand("gext", ["install", "just-perfection-desktop@just-perfection"]);

runCommand("gext", ["install", "transparent-window-moving@noobsai.github.com"]);

runCommand("gext", ["install", "grand-theft-focus@zalckos.github.com"]);

runCommand(
	"paru",
	[
		"-Rcssun",
		"--noconfirm",
		"gnome-calculator",
		"gnome-console",
		"gnome-maps",
		"gnome-music",
		"gnome-tour",
		"gnome-weather",
	],
	{
		allowFailure: true,
	},
);
