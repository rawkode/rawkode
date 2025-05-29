import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("carapace")
	.description("Shell completion framework")
	.tags("cli", "shell", "completion")
	.packageInstall({
		manager: "pacman",
		packages: ["carapace-bin"],
	})
	.command({
		command: "nu",
		args: [
			"-c",
			'carapace _carapace nushell | save --force ($nu.user-autoload-dirs | path join "carapace.nu")',
		],
	})
	.build();
