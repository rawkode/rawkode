import { defineModule } from "../../core/module-builder.ts";

export default defineModule("catppuccin")
	.description("Catppuccin theme configuration")
	.tags("theme", "appearance")
	.packageInstall({
		manager: "arch",
		packages: ["catppuccin-cursors-mocha"],
	})
	.command({
		command: "dconf",
		args: ["load", "/"],
		stdin: `${import.meta.dirname}/dconf.ini`,
	})
	.symlink({
		source: "gtk-settings.ini",
		target: "~/.config/gtk-3.0/settings.ini",
	})
	.symlink({
		source: "gtk-settings.ini",
		target: "~/.config/gtk-4.0/settings.ini",
	})
	.symlink({
		source: "nushell.nu",
		target: "~/.config/nushell/autoload/catppuccin.nu",
	})
	.build();
