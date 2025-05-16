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

await archInstall(["gnome-extensions-cli"]);

await runCommand("gext", ["install", "advanced-alt-tab@G-dH.github.com"]);
await dconfImport(`${import.meta.dirname}/advanced-alt-tab.dconf`);

await runCommand("gext", ["install", "blur-my-shell@aunetx"]);

await runCommand("gext", ["install", "burn-my-windows@schneegans.github.com"]);
await dconfImport(`${import.meta.dirname}/burn-my-windows.dconf`);

ensureHomeSymlink(
	`${import.meta.dirname}/burn-my-windows.conf`,
	".config/burn-my-windows/profiles/focus.conf",
);

await runCommand("gext", ["install", "caffeine@patapon.info"]);
await runCommand("gext", ["install", "clipboard-indicator@tudmotu.com"]);

await runCommand("gext", [
	"install",
	"compiz-windows-effect@hermes83.github.com",
]);
await runCommand("gext", ["install", "desktop-cube@schneegans.github.com"]);

await runCommand("gext", ["install", "emoji-copy@felipeftn"]);

await runCommand("gext", ["install", "appindicatorsupport@rgcjonas.gmail.com"]);

await runCommand("gext", ["install", "space-bar@luchrioh"]);

await runCommand("gext", ["install", "gsconnect@andyholmes.github.io"]);

await runCommand("gext", [
	"install",
	"just-perfection-desktop@just-perfection",
]);

await runCommand("gext", [
	"install",
	"transparent-window-moving@noobsai.github.com",
]);

await runCommand("gext", ["install", "grand-theft-focus@zalckos.github.com"]);

await runCommand(
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
