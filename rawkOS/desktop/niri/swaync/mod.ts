/// <reference path="../../../types.d.ts" />

export default defineModule("swaync")
	.description("Notification center for Sway/Wayland")
	.actions([
		packageInstall({
			names: ["swaync"],
		}),
	]);
