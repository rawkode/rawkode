import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("niri")
	.description("Scrollable tiling compositor")
	.depends("waybar", "swaync")
	.with(() => [
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
			source: "config.kdl",
			target: "niri/config.kdl",
		}),
		linkDotfile({
			source: "portals.conf",
			target: "xdg-desktop-portal/portals.conf",
		}),
		linkDotfile({
			source: "../wallpapers/rawkode-academy.png",
			target: "niri/wallpaper.png",
		}),
		linkDotfile({
			source: "swaylock.conf",
			target: "swaylock/config",
		}),
		linkDotfile({
			source: "fuzzel.ini",
			target: "fuzzel/fuzzel.ini",
		}),
	]);
