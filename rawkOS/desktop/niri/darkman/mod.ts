import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("darkman")
	.description("Darkman - A dark mode switcher for Linux")
	.with(() => [
		packageInstall({
			names: ["darkman"],
		}),
	]);
