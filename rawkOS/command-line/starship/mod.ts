import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("starship")
	.description("Cross-shell prompt")
	.tags("cli", "shell", "prompt")
	.packageInstall({
		manager: "pacman",
		packages: ["starship"],
	})
	.command({
		command: "nu",
		args: [
			"-c",
			'starship init nu | save -f ($nu.user-autoload-dirs | path join "starship.nu")',
		],
	})
	.symlink({
		source: "starship.fish",
		target: ".config/fish/conf.d/starship.fish",
	})
	.symlink({
		source: "config.toml",
		target: ".config/starship.toml",
	})
	.build();
