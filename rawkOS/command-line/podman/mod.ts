import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("podman")
	.description("Container runtime")
	.tags("cli", "containers", "development")
	.with(() => [
		packageInstall({
			names: ["podman"],
	}),
	]);
