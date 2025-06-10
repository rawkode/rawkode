export default defineModule("zed")
	.description("Code editor")
	.tags(["desktop", "development", "editor"])
	.actions([
		packageInstall({
			names: ["zed"],
		}),
		linkDotfile({
			from: "keymap.json",
			to: "zed/keymap.json",
			force: true,
		}),
		linkDotfile({
			from: "settings.json",
			to: "zed/settings.json",
			force: true,
		}),
	]);
