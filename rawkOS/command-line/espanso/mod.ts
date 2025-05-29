import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("espanso")
	.description("Text expander")
	.tags("cli", "productivity", "text")
	.packageInstall({
		manager: "pacman",
		packages: ["espanso-wayland"],
	})
	.symlink({
		source: "config",
		target: ".config/espanso/config",
	})
	.symlink({
		source: "match",
		target: ".config/espanso/match",
	})
	.command({
		command: "systemctl",
		args: ["--user", "enable", "--now", "espanso.service"],
	})
	.build();
