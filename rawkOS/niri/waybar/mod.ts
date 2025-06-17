/// <reference path="../../../types.d.ts" />

export default defineModule("waybar")
	.description("Wayland bar")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["waybar", "helvum"],
		}),
		linkFile({
			target: "config.jsonc",
			source: "waybar/config",
			force: true,
		}),
		linkFile({
			target: "style-dark.css",
			source: "waybar/style-dark.css",
			force: true,
		}),
		linkFile({
			target: "style-light.css",
			source: "waybar/style-light.css",
			force: true,
		}),
	]);
