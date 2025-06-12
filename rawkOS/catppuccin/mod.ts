export default defineModule("catppuccin")
	.description("Catppuccin theme configuration")
	.tags(["theme"])
	.actions([
		packageInstall({
			names: ["catppuccin-cursors-mocha"],
		}),
		linkFile({
			target: "gtk-settings.ini",
			source: "~/.config/gtk-3.0/settings.ini",
			force: true,
		}),
		linkFile({
			target: "gtk-settings.ini",
			source: "~/.config/gtk-4.0/settings.ini",
			force: true,
		}),
		linkFile({
			target: "nushell.nu",
			source: "~/.config/nushell/autoload/catppuccin.nu",
			force: true,
		}),
	]);
