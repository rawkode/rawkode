import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("github")
	.description("GitHub CLI and configuration")
	.tags("cli", "git", "development")
	.symlink({
		source: "known_hosts",
		target: ".ssh/known_hosts",
		force: true,
	})
	.packageInstall({
		manager: "pacman",
		packages: ["github-cli"],
	})
	.build();
