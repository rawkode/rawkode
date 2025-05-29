import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("dconf-editor")
	.description("GNOME configuration editor")
	.tags("desktop", "gnome", "configuration")
	.packageInstall({
		manager: "flatpak",
		packages: ["ca.desrt.dconf-editor"],
	})
	.build();
