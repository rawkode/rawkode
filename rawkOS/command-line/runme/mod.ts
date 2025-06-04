import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("runme")
	.description("Run commands from markdown")
	.tags("cli", "documentation", "development")
	.with(() => [
		packageInstall({
			names: ["github.com/stateful/runme@latest"],
	}),
	]);
