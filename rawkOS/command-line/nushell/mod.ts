export default defineModule("nushell")
	.description("Nu shell configuration")
	.actions([
		packageInstall({
			names: ["nushell"],
		}),
		executeCommand({
			command: "nu",
			args: ["-c", "$nu.user-autoload-dirs | each { |d| mkdir $d }"],
			escalate: false,
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
