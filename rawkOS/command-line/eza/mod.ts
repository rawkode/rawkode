import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("eza")
	.description("Modern ls replacement")
	.tags("cli", "utilities", "files")
	.packageInstall({
		manager: "pacman",
		packages: ["eza"],
	})
	.symlink({
		source: "eza.fish",
		target: ".config/fish/conf.d/eza.fish",
	})
	.build();
