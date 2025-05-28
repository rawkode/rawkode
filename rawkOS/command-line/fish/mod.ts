import { defineModule } from "../../core/module-builder.ts";

export default defineModule("fish")
	.description("Fish shell configuration")
	.tags("cli", "shell")
	.packageInstall({
		manager: "pacman",
		packages: ["fish"],
	})
	.command({
		command: "sudo",
		args: ["homectl", "update", process.env.USER || "", "--shell", "/usr/bin/fish"],
		description: "Set fish as default shell",
		privileged: true,
		skipIf: () => process.env.SHELL?.endsWith("/fish") || false,
	})
	.symlink({
		source: "magic-enter.fish",
		target: ".config/fish/conf.d/magic-enter.fish",
	})
	.symlink({
		source: "aliases.fish",
		target: ".config/fish/conf.d/aliases.fish",
	})
	.build();
