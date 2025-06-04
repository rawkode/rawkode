import { defineModule, packageInstall, executeCommand, linkDotfile } from "@korora-tech/dhd";

export default defineModule("nushell")
	.description("Nu shell configuration")
	.with(() => [
		packageInstall({
			names: ["nushell"],
		}),
		// TODO: Add skipIf condition support - not yet available in dhd
		// executeCommand({
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
		// }),
		executeCommand({
			command: "nu",
			args: ["-c", "$nu.user-autoload-dirs | each { |d| mkdir $d }"],
		}),
		linkDotfile({
			source: "config.nu",
			target: "nushell/config.nu",
		}),
		linkDotfile({
			source: "env.nu",
			target: "nushell/env.nu",
		}),
	]);
