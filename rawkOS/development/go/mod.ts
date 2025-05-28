import { defineModule } from "../../core/module-builder.ts";

export default defineModule("go")
	.description("Go programming language")
	.tags("development", "programming", "go")
	.packageInstall({
		manager: "pacman",
		packages: ["go"],
	})
	.symlink({
		source: "go.fish",
		target: ".config/fish/conf.d/go.fish",
	})
	.symlink({
		source: "go.nu",
		target: ".config/nushell/autoload/go.nu",
	})
	.build();
