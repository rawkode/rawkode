export default defineModule("nushell")
	.description("Nu shell configuration")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["nushell"],
		}),
		executeCommand({
			command: "nu",
			args: ["-c", "$nu.user-autoload-dirs | each { |d| mkdir $d }"],
			escalate: false,
		}),
		linkFile({
			target: "config.nu",
			source: "nushell/config.nu",
			force: true,
		}),
		linkFile({
			target: "env.nu",
			source: "nushell/env.nu",
			force: true,
		}),
	]);
