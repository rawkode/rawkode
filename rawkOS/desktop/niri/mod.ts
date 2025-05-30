import { defineModule } from "@rawkode/dhd/core/module-builder.ts";
import { conditions } from "@rawkode/dhd/core/conditions.ts";

export default defineModule("niri")
	.description("Scrollable tiling compositor")
	.tags("desktop", "compositor", "wayland")
	.dependsOn("waybar", "swaync")
	.packageInstall({
		manager: "arch",
		packages: [
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
	})
	.packageInstall({
		manager: "flatpak",
		packages: ["io.github.dyegoaurelio.simple-wireplumber-gui"],
	})
	.symlink({
		source: "config.kdl",
		target: ".config/niri/config.kdl",
	})
	.symlink({
		source: "portals.conf",
		target: ".config/xdg-desktop-portal/portals.conf",
	})
	.symlink({
		source: "../wallpapers/rawkode-academy.png",
		target: ".config/niri/wallpaper.png",
	})
	.symlink({
		source: "swaylock.conf",
		target: ".config/swaylock/config",
	})
	.symlink({
		source: "fuzzel.ini",
		target: ".config/fuzzel/fuzzel.ini",
	})
	.build();
