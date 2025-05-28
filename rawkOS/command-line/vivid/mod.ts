import { defineModule } from "../../core/module-builder.ts";

export default defineModule("vivid")
	.description("LS_COLORS generator")
	.tags("cli", "utilities", "colors")
	.packageInstall({
		manager: "pacman",
		packages: ["vivid"],
	})
	.build();
