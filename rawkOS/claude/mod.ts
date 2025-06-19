export default defineModule("claude")
	.description("Claude AI CLI")
	.tags(["developer"])
	.actions([
		packageInstall({
			names: ["@anthropic-ai/claude-code"],
			manager: "bun",
		}),
		linkFile({
			source: "fish/conf.d/claude.fish",
			target: "config.fish",
			force: true,
		}),
		executeCommand({
			command: "claude",
			args: [
				"mcp",
				"add",
				"-s",
				"user",
				"-t",
				"http",
				"github",
				"https://api.githubcopilot.com/mcp/",
			],
		}),
	]);
