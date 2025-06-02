import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("nushell")
	.description("Nu shell configuration")
	.tags("cli", "shell")
	.packageInstall({
		manager: "pacman",
		packages: ["nushell"],
	})
	// .command({
	// 	command: "sudo",
	// 	args: [
	// 		"homectl",
	// 		"update",
	// 		process.env.USER || "",
	// 		"--shell",
	// 		"/usr/bin/nu",
	// 	],
	// 	privileged: true,
	// 	skipIf: () => process.env.SHELL?.endsWith("/nu") || false,
	// })
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
