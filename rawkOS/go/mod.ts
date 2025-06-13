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
			// This needs early loading, as it configures PATH for Go installed packages
			source: "nushell/autoload/0-go.nu",
			force: true,
		}),
	]);
