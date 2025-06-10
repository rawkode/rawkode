export default defineModule("direnv")
	.description("Directory-based environment variables")
	.actions([
		packageInstall({
			names: ["direnv"],
		}),
		linkDotfile({
			from: "direnv.fish",
			to: "fish/conf.d/direnv.fish",
			force: true,
		}),
		linkDotfile({
			from: "direnv.nu",
			to: "nushell/autoload/direnv.nu",
			force: true,
		}),
	]);
