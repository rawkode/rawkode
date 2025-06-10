export default defineModule("claude")
	.description("Claude AI CLI")
	.actions([
		packageInstall({
			names: ["@anthropic-ai/claude-code"],
			manager: "bun",
		}),
	]);
