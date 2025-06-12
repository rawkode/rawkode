export default defineModule("runme")
	.description("Run commands from markdown")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["github.com/stateful/runme@latest"],
			manager: "Go",
		}),
	]);
