export default defineModule("claude")
	.description("Claude AI CLI")
	.tags(["developer"])
	.actions([
		packageInstall({
			names: ["@anthropic-ai/claude-code"],
			manager: "bun",
		}),
	]);
