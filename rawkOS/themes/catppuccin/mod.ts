import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("catppuccin")
	.description("Catppuccin theme configuration")
	.tags("theme", "appearance")
	.with(() => [
		packageInstall({
			names: ["catppuccin-cursors-mocha"],
	}),
		linkDotfile({
			source: "gtk-settings.ini",
		target: "~/.config/gtk-3.0/settings.ini",
	}),
		linkDotfile({
			source: "gtk-settings.ini",
		target: "~/.config/gtk-4.0/settings.ini",
	}),
		linkDotfile({
			source: "nushell.nu",
		target: "~/.config/nushell/autoload/catppuccin.nu",
	}),
	]);
