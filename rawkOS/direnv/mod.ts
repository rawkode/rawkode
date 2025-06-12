export default defineModule("direnv")
	.description("Directory-based environment variables")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["direnv"],
		}),
		linkFile({
			target: "direnv.fish",
			source: "fish/conf.d/direnv.fish",
			force: true,
		}),
		linkFile({
			target: "direnv.nu",
			source: "nushell/autoload/direnv.nu",
			force: true,
		}),
	]);
