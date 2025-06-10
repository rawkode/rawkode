export default defineModule("ghostty")
	.description("GPU-accelerated terminal")
	.tags(["desktop", "terminal"])
	.actions([
		packageInstall({
			names: ["ghostty"],
		}),
		linkDotfile({
			from: "config.ini",
			to: "ghostty/config",
			force: true,
		}),
	]);
