import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("atuin")
	.description("Shell history sync")
	.tags("cli", "shell", "history")
	.packageInstall({
		manager: "pacman",
		packages: ["atuin"],
	})
	.command({
		command: "nu",
		args: [
			"-c",
			'atuin init nu | save -f ($nu.user-autoload-dirs | path join "atuin.nu")',
		],
	})
	.symlink({
		source: "config.toml",
		target: ".config/atuin/config.toml",
	})
	.symlink({
		source: "atuin.fish",
		target: ".config/fish/conf.d/atuin.fish",
	})
	.build();
