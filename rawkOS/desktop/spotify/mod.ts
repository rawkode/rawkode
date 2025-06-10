export default defineModule("spotify")
	.description("Music streaming")
	.tags(["desktop", "media", "music"])
	.actions([
		packageInstall({
			names: ["com.spotify.Client"],
		}),
	]);
