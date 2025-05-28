import { defineModule } from "../../core/module-builder.ts";

export default defineModule("nushell")
	.description("Nushell - A modern shell written in Rust")
	.tags("command-line", "shell")
	.packageInstall({
		manager: "arch",
		packages: ["nushell"],
	})
	.command({
		command: "nu",
		args: ["-c", "$nu.user-autoload-dirs | each { |d| mkdir $d }"],
	})
	.symlink({
		source: `${import.meta.dirname}/config.nu`,
		target: "~/.config/nushell/config.nu",
	})
	.symlink({
		source: `${import.meta.dirname}/env.nu`,
		target: "~/.config/nushell/env.nu",
	})
	.build();
