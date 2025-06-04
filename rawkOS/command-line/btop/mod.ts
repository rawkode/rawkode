import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("btop")
	.description("Resource monitor")
	.with(() => [
		packageInstall({
			names: ["btop"],
		}),
	]);
