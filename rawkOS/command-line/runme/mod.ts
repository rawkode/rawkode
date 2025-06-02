import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("runme")
	.description("Run commands from markdown")
	.tags("cli", "documentation", "development")
	.packageInstall({
		manager: "go",
		packages: ["github.com/stateful/runme@latest"],
	})
	.build();
