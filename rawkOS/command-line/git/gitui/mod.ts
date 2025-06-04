import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("gitui")
	.description("Terminal UI for git")
	.tags("cli", "git", "ui")
	.with(() => [
		packageInstall({
			names: ["gitui"],
		}),
		linkDotfile({
			source: "theme.ron",
			target: "gitui/theme.ron",
		}),
	]);
