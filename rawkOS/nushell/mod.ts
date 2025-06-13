export default defineModule("nushell")
	.description("Nu shell configuration")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["nushell"],
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
