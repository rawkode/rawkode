export default defineModule("niri")
	.description("Scrollable tiling compositor")
	.depends("waybar", "swaync")
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
		linkDotfile({
			from: "config.kdl",
			to: "niri/config.kdl",
			force: true,
		}),
		linkDotfile({
			from: "portals.conf",
			to: "xdg-desktop-portal/portals.conf",
			force: true,
		}),
		linkDotfile({
			from: "../wallpapers/rawkode-academy.png",
			to: "niri/wallpaper.png",
			force: true,
		}),
		linkDotfile({
			from: "swaylock.conf",
			to: "swaylock/config",
			force: true,
		}),
		linkDotfile({
			from: "fuzzel.ini",
			to: "fuzzel/fuzzel.ini",
			force: true,
		}),
	]);
