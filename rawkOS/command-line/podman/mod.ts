import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("podman")
	.description("Container runtime")
	.tags("cli", "containers", "development")
	.packageInstall({
		manager: "pacman",
		packages: ["podman"],
	})
	.build();
