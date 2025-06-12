// TODO Configure swww with wallpaper?
export default defineModule("wallpapers")
	.description("Desktop wallpapers")
	.tags(["desktop"])
	.actions([
		linkFile({
			target: "rawkode-academy.png",
			source: "wallpapers/rawkode-academy.png",
			force: true,
		}),
	]);
