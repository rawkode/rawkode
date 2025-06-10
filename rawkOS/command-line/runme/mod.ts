export default defineModule("runme")
	.description("Run commands from markdown")
	.tags(["cli", "documentation", "development"])
	.actions([
		packageInstall({
			names: ["github.com/stateful/runme@latest"],
			// TODO Why is this not enumerated in the global types?
			manager: "go",
		}),
	]);
