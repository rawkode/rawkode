export default defineModule("wezterm")
	.description("GPU-accelerated terminal")
	.tags(["desktop", "terminal"])
	.actions([
		packageInstall({
			names: ["wezterm"],
		}),
		linkDotfile({
			from: "config.lua",
			to: "wezterm/wezterm.lua",
			force: true,
		}),
		linkDotfile({
			from: "appearance.lua",
			to: "wezterm/appearance.lua",
			force: true,
		}),
	]);
