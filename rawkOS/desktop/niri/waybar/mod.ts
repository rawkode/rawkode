/// <reference path="../../../types.d.ts" />

export default defineModule("waybar")
	.description("Wayland bar")
	.actions([
		packageInstall({
			names: ["waybar", "helvum"],
		}),
		linkDotfile({
			from: "config",
			to: "waybar/config",
			force: true,
		}),
		linkDotfile({
			from: "style.css",
			to: "waybar/style.css",
			force: true,
		}),
	]);
