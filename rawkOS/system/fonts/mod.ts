import { defineModule } from "../../core/module-builder.ts";

export default defineModule("fonts")
	.description("System fonts")
	.tags("fonts", "ui")
	.packageInstall({
		manager: "pacman",
		packages: ["otf-monaspace", "otf-monaspace-nerd"],
	})
	.build();
