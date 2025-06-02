import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("gitbutler")
	.description("Git branch management")
	.tags("desktop", "git", "development")
	.packageInstall({
		manager: "pacman",
		packages: ["gitbutler-bin"],
	})
	.build();
