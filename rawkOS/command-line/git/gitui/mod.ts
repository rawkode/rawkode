/// <reference path="../../../types.d.ts" />

export default defineModule("gitui")
	.description("Terminal UI for git")
	.tags(["cli", "git", "ui"])
	.actions([
		packageInstall({
			names: ["gitui"],
		}),
		linkDotfile({
			from: "theme.ron",
			to: "gitui/theme.ron",
			force: true,
		}),
	]);
