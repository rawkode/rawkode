export default defineModule("go")
	.description("Go programming language")
	.tags(["development"])
	.actions([
		packageInstall({
			names: ["go"],
		}),
		linkFile({
			target: "go.fish",
			source: "fish/conf.d/go.fish",
			force: true,
		}),
		linkFile({
			target: "go.nu",
			source: "nushell/autoload/go.nu",
			force: true,
		}),
	]);
