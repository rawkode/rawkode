export default defineModule("niri")
	.description("Scrollable tiling compositor")
	.tags(["desktop"])
	.dependsOn(["darkman", "swaync", "waybar"])
	.actions([
		packageInstall({
			names: [
				"bemoji",
				"catppuccin-cursors-mocha",
				"fuzzel",
				"gauntlet-bin",
				"mako",
				"niri",
				"polkit-gnome",
				"seahorse",
				"swww",
				"swaylock",
				"swayidle",
				"wireplumber",
				"xdg-desktop-portal-gnome",
				"xwayland-satellite",
			],
		}),
		linkFile({
			target: "fuzzel-window-picker.sh",
			source: "~/.local/bin/fuzzel-window-picker",
			force: true,
		}),
		linkFile({
			target: "config.kdl",
			source: "niri/config.kdl",
			force: true,
		}),
		linkFile({
			target: "portals.conf",
			source: "xdg-desktop-portal/portals.conf",
			force: true,
		}),
		linkFile({
			target: "../wallpapers/rawkode-academy.png",
			source: "niri/wallpaper.png",
			force: true,
		}),
		linkFile({
			target: "swaylock.conf",
			source: "swaylock/config",
			force: true,
		}),
		linkFile({
			target: "fuzzel.ini",
			source: "fuzzel/fuzzel.ini",
			force: true,
		}),
	]);
