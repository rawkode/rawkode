import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("dconf-editor")
	.description("GNOME configuration editor")
	.tags("desktop", "configuration")
	.with(() => [
		packageInstall({
			names: ["ca.desrt.dconf-editor"],
		}),
	]);
