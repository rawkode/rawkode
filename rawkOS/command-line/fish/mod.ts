import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("fish")
	.description("Fish shell configuration")
	.tags("cli", "shell")
	.packageInstall({
		manager: "pacman",
		packages: ["fish"],
	})
	.symlink({
		source: "magic-enter.fish",
		target: ".config/fish/conf.d/magic-enter.fish",
	})
	.symlink({
		source: "aliases.fish",
		target: ".config/fish/conf.d/aliases.fish",
	})
	.build();
