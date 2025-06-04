import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("bat")
	.description("Cat replacement with syntax highlighting")
	.with(() => [
		packageInstall({
			names: ["bat"],
		}),
	]);
