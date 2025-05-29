import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("ripgrep")
	.description("Fast grep replacement")
	.tags("cli", "utilities", "search")
	.packageInstall({
		manager: "pacman",
		packages: ["ripgrep"],
	})
	.build();
