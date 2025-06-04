import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("kubernetes")
	.description("Kubernetes tools")
	.tags("cli", "kubernetes", "cloud")
	.with(() => [
		packageInstall({
			names: ["kubectl"],
	}),
	]);
