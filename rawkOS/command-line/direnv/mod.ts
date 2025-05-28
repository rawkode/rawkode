import { defineModule } from "../../core/module-builder.ts";

export default defineModule("direnv")
	.description("Directory-based environment variables")
	.tags("cli", "environment", "development")
	.packageInstall({
		manager: "pacman",
		packages: ["direnv"],
	})
	.symlink({
		source: "direnv.fish",
		target: ".config/fish/conf.d/direnv.fish",
	})
	.symlink({
		source: "direnv.nu",
		target: ".config/nushell/autoload/direnv.nu",
	})
	.build();
