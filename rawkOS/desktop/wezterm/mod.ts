import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("wezterm")
	.description("GPU-accelerated terminal")
	.tags("desktop", "terminal")
	.packageInstall({
		manager: "pacman",
		packages: ["wezterm"],
	})
	.symlink({
		source: "config.lua",
		target: ".config/wezterm/wezterm.lua",
	})
	.build();
