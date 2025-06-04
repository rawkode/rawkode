import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("claude")
	.description("Claude AI CLI")
	.with(() => [
		packageInstall({
			names: ["@anthropic-ai/claude-code"],
			manager: "bun",
		}),
	]);
