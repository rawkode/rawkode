/// <reference path="../../../types.d.ts" />

export default defineModule("waybar")
	.description("Wayland bar")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["waybar", "helvum"],
		}),
		linkFile({
			target: "config",
			source: "waybar/config",
			force: true,
		}),
		linkFile({
			target: "style.css",
			source: "waybar/style.css",
			force: true,
		}),
	]);
