import { defineModule } from "../../core/module-builder.ts";

export default defineModule("zellij")
	.description("Terminal multiplexer")
	.tags("cli", "terminal", "multiplexer")
	.packageInstall({
		manager: "pacman",
		packages: ["zellij"],
	})
	.symlink({
		source: "config.kdl",
		target: ".config/zellij/config.kdl",
	})
	.symlink({
		source: "zellij.nu",
		target: ".config/nushell/autoload/zellij.nu",
	})
	.build();
