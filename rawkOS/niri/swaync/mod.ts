/// <reference path="../../../types.d.ts" />

export default defineModule("swaync")
	.description("Notification center for Sway/Wayland")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["swaync"],
		}),
	]);
