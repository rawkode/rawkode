import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("btop")
	.description("Resource monitor")
	.tags("cli", "system", "monitoring")
	.packageInstall({
		manager: "pacman",
		packages: ["btop"],
	})
	.build();