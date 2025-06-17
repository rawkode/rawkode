export default defineModule("wezterm")
	.description("GPU-accelerated terminal")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["wezterm-git"],
		}),
		linkFile({
			source: "wezterm/wezterm.lua",
			target: "config.lua",
			force: true,
		}),
		linkFile({
			source: "wezterm/appearance.lua",
			target: "appearance.lua",
			force: true,
		}),
	]);
