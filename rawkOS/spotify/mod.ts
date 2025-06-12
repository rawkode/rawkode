export default defineModule("spotify")
	.description("Music streaming")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["com.spotify.Client"],
			manager: "flatpak",
		}),
	]);
