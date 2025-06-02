import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("bun")
	.description("Bun TypeScript runtime")
	.tags("development", "programming")
	.packageInstall({
		manager: "pacman",
		packages: ["bun-bin"],
	})
	.symlink({
		source: "bun.nu",
		target: ".config/nushell/autoload/bun.nu",
	})
	.build();
