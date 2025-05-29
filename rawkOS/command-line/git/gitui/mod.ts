import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("gitui")
	.description("Terminal UI for git")
	.tags("cli", "git", "ui")
	.packageInstall({
		manager: "pacman",
		packages: ["gitui"],
	})
	.symlink({
		source: "theme.ron",
		target: ".config/gitui/theme.ron",
	})
	.build();
