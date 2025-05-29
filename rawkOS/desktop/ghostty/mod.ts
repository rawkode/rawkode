import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("ghostty")
	.description("GPU-accelerated terminal")
	.tags("desktop", "terminal")
	.packageInstall({
		manager: "pacman",
		packages: ["ghostty"],
	})
	.symlink({
		source: "config.ini",
		target: ".config/ghostty/config",
	})
	.build();
