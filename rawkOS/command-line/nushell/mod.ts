export default defineModule("nushell")
	.description("Nu shell configuration")
	.actions([
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
			from: "config.nu",
			to: "nushell/config.nu",
			force: true,
		}),
		linkDotfile({
			from: "env.nu",
			to: "nushell/env.nu",
			force: true,
		}),
	]);
