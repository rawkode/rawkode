export default defineModule("go")
	.description("Go programming language")
	.tags(["development", "programming", "go"])
	.actions([
		packageInstall({
			names: ["go"],
		}),
		linkDotfile({
			from: "go.fish",
			to: "fish/conf.d/go.fish",
			force: true,
		}),
		linkDotfile({
			from: "go.nu",
			to: "nushell/autoload/go.nu",
			force: true,
		}),
	]);
