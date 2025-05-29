import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("firefox")
	.description("Firefox web browser")
	.tags("desktop", "browser", "web")
	.packageInstall({
		manager: "pacman",
		packages: ["firefox-developer-edition"],
	})
	.build();
