import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("python")
	.description("Python programming language")
	.tags("development", "programming", "python")
	.packageInstall({
		manager: "pacman",
		packages: ["uv"],
	})
	.build();
