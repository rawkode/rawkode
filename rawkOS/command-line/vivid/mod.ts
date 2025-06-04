import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("vivid")
	.description("LS_COLORS generator")
	.tags("cli", "utilities", "colors")
	.with(() => [
		packageInstall({
			names: ["vivid"],
	}),
	]);
