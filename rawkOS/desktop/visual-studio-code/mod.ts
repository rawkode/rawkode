import { defineModule } from "../../core/module-builder.ts";

export default defineModule("visual-studio-code")
	.description("Code editor")
	.tags("desktop", "development", "editor")
	.packageInstall({
		manager: "pacman",
		packages: ["visual-studio-code-bin"],
	})
	.symlink({
		source: "argv.json",
		target: ".vscode/argv.json",
	})
	.build();
