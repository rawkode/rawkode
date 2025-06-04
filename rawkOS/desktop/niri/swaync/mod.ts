import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("swaync")
	.description("Notification center for Sway/Wayland")
	.with(() => [
		packageInstall({
			names: ["swaync"],
		}),
	]);
