import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("spotify")
	.description("Music streaming")
	.tags("desktop", "media", "music")
	.packageInstall({
		manager: "flatpak",
		packages: ["com.spotify.Client"],
	})
	.build();
