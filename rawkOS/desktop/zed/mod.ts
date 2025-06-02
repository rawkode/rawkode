import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("zed")
	.description("Code editor")
	.tags("desktop", "development", "editor")
	.packageInstall({
		manager: "pacman",
		packages: ["zed"],
	})
	.symlink({
		source: "keymap.json",
		target: ".config/zed/keymap.json",
	})
	.symlink({
		source: "settings.json",
		target: ".config/zed/settings.json",
	})
	.build();
