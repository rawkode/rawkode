import { defineModule } from "../../core/module-builder.ts";

export default defineModule("bat")
	.description("Cat replacement with syntax highlighting")
	.tags("cli", "utilities")
	.packageInstall({
		manager: "pacman",
		packages: ["bat"],
	})
	.build();
