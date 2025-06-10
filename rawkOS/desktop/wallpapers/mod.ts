// TODO Configure swww with wallpaper?
export default defineModule("wallpapers")
	.description("Desktop wallpapers")
	.tags(["desktop", "customization"])
	.actions([
		linkDotfile({
			from: "rawkode-academy.png",
			to: "wallpapers/rawkode-academy.png",
			force: true,
		}),
	]);
