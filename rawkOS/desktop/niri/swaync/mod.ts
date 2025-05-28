import { defineModule } from "../../../core/module-builder.ts";
import { conditions } from "../../../core/conditions.ts";

export default defineModule("swaync")
	.description("Notification center for Sway/Wayland")
	.tags("desktop", "wayland", "notifications")
	.when(conditions.and(conditions.isWayland, conditions.or(conditions.isNiri)))
	.packageInstall({
		manager: "pacman",
		packages: ["swaync"],
	})
	.build();
