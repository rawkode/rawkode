import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("rust")
	.description("Rust programming language")
	.tags("development", "programming", "rust")
	.packageInstall({
		manager: "pacman",
		packages: ["rustup"],
	})
	.command({
		command: "rustup",
		args: ["default", "stable"],
	})
	.symlink({
		source: "rust.fish",
		target: ".config/fish/conf.d/rust.fish",
	})
	.symlink({
		source: "rust.nu",
		target: ".config/nushell/autoload/rust.nu",
	})
	.build();
