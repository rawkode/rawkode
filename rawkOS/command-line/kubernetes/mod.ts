import { defineModule } from "../../core/module-builder.ts";

export default defineModule("kubernetes")
	.description("Kubernetes tools")
	.tags("cli", "kubernetes", "cloud")
	.packageInstall({
		manager: "pacman",
		packages: ["kubectl"],
	})
	.build();
