import { defineModule, packageInstall } from "@korora-tech/dhd";
import { conditions } from "@korora-tech/dhd";

export default defineModule("swaync")
	.description("Notification center for Sway/Wayland")
	.tags("desktop", "wayland", "notifications")
	.with(() => [
		packageInstall({
			names: ["swaync"],
	}),
	]);
