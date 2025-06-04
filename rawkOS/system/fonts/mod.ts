import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("fonts")
	.description("System fonts")
	.with(() => [
		packageInstall({
			names: ["otf-monaspace", "otf-monaspace-nerd"],
		}),
	]);
