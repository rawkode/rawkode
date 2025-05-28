import { defineModule } from "../../core/module-builder.ts";

export default defineModule("zoxide")
	.description("Smart cd command")
	.tags("cli", "navigation")
	.packageInstall({
		manager: "pacman",
		packages: ["zoxide", "fzf"],
	})
	.command({
		command: "nu",
		args: [
			"-c",
			'zoxide init nushell | save -f ($nu.user-autoload-dirs | path join "zoxide.nu")',
		],
	})
	.symlink({
		source: "zoxide.fish",
		target: ".config/fish/conf.d/zoxide.fish",
	})
	.build();
