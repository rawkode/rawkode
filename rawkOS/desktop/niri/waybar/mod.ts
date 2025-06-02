import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";
import { conditions } from "@korora-tech/dhd/core/conditions.ts";

export default defineModule("waybar")
	.description("Wayland bar")
	.tags("desktop", "wayland", "bar")
	.when(conditions.and(conditions.isWayland, conditions.or(conditions.isNiri)))
	.packageInstall({
		manager: "pacman",
		packages: ["waybar", "helvum"],
	})
	.when(conditions.and(conditions.isWayland, conditions.or(conditions.isNiri)))
	.symlink({
		source: "config",
		target: ".config/waybar/config",
	})
	.when(conditions.and(conditions.isWayland, conditions.or(conditions.isNiri)))
	.symlink({
		source: "style.css",
		target: ".config/waybar/style.css",
	})
	.build();
