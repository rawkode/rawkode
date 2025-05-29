import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("jj")
	.description("Jujutsu version control")
	.tags("cli", "vcs", "development")
	.packageInstall({
		manager: "pacman",
		packages: ["jujutsu"],
	})
	.symlink({
		source: "config.toml",
		target: ".config/jj/config.toml",
	})
	.build();
