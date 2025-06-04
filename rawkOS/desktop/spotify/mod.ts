import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("spotify")
	.description("Music streaming")
	.tags("desktop", "media", "music")
	.with(() => [
		packageInstall({
			names: ["com.spotify.Client"],
	}),
	]);
