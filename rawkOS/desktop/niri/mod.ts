import { defineModule } from "../../core/module-builder.ts";
import { conditions } from "../../core/conditions.ts";

export default defineModule("niri")
	.description("Scrollable tiling compositor")
	.tags("desktop", "compositor", "wayland")
	.dependsOn("waybar", "swaync")
	.when(conditions.isNiri)
	.packageInstall({
		manager: "pacman",
		packages: [
			"catppuccin-cursors-mocha",
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
	.when(conditions.isNiri)
	.packageInstall({
		manager: "flatpak",
		packages: ["io.github.dyegoaurelio.simple-wireplumber-gui"],
	})
	.when(conditions.isNiri)
	.symlink({
		source: "config.kdl",
		target: ".config/niri/config.kdl",
	})
	.when(conditions.isNiri)
	.symlink({
		source: "portals.conf",
		target: ".config/xdg-desktop-portal/portals.conf",
	})
	.when(conditions.isNiri)
	.symlink({
		source: "../wallpapers/rawkode-academy.png",
		target: ".config/niri/wallpaper.png",
	})
	.when(conditions.isNiri)
	.symlink({
		source: "swaylock.conf",
		target: ".config/swaylock/config",
	})
	.build();
