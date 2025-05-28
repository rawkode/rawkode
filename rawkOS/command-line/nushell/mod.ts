import { defineModule } from "../../core/module-builder.ts";

export default defineModule("nushell")
	.description("Nu shell configuration")
	.tags("cli", "shell")
	.packageInstall({
		manager: "pacman",
		packages: ["nushell"],
	})
	.command({
		command: "nu",
		args: ["-c", "$nu.user-autoload-dirs | each { |d| mkdir $d }"],
	})
	.symlink({
		source: "config.nu",
		target: ".config/nushell/config.nu",
	})
	.symlink({
		source: "env.nu",
		target: ".config/nushell/env.nu",
	})
	.build();
