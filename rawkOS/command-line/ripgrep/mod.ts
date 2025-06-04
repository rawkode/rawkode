import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("ripgrep")
	.description("Fast grep replacement")
	.with(() => [
		packageInstall({
			names: ["ripgrep"],
		}),
	]);
