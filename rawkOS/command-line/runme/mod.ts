export default defineModule("runme")
	.description("Run commands from markdown")
	.tags(["cli", "documentation", "development"])
	.actions([
		packageInstall({
			names: ["github.com/stateful/runme@latest"],
		}),
	]);
