import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("wezterm")
	.description("GPU-accelerated terminal")
	.tags("desktop", "terminal")
	.with(() => [
		packageInstall({
			names: ["wezterm"],
	}),
		linkDotfile({
			source: "config.lua",
		target: "wezterm/wezterm.lua",
	}),
	]);
