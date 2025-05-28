import { defineModule } from "../../core/module-builder.ts";

export default defineModule("claude")
	.description("Claude AI CLI")
	.tags("cli", "ai", "development")
	.packageInstall({
		manager: "pacman",
		packages: ["claude-code"],
	})
	.build();
