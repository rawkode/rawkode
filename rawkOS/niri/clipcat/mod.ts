export default defineModule("clipcat")
	.description("Clipboard Manager")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["clipcat"],
		}),
		linkFile({
			source: "clipcat/clipcatd.toml",
			target: "clipcatd.toml",
			force: true,
		}),
		linkFile({
			source: "clipcat/clipcatctl.toml",
			target: "clipcatctl.toml",
			force: true,
		}),
		linkFile({
			source: "clipcat/clipcat-menu.toml",
			target: "clipcat-menu.toml",
			force: true,
		}),
	]);
