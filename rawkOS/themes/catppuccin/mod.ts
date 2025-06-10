export default defineModule("catppuccin")
	.description("Catppuccin theme configuration")
	.tags(["theme", "appearance"])
	.actions([
		packageInstall({
			names: ["catppuccin-cursors-mocha"],
		}),
		linkDotfile({
			from: "gtk-settings.ini",
			to: "~/.config/gtk-3.0/settings.ini",
			force: true,
		}),
		linkDotfile({
			from: "gtk-settings.ini",
			to: "~/.config/gtk-4.0/settings.ini",
			force: true,
		}),
		linkDotfile({
			from: "nushell.nu",
			to: "~/.config/nushell/autoload/catppuccin.nu",
			force: true,
		}),
	]);
