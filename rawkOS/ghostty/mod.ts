export default defineModule("ghostty")
	.description("GPU-accelerated terminal")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["ghostty"],
		}),
		linkFile({
			target: "config.ini",
			source: "ghostty/config",
			force: true,
		}),
	]);
