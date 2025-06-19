export default defineModule("zed")
	.description("Code editor")
	.tags(["desktop", "development"])
	.actions([
		packageInstall({
			names: ["zed"],
		}),
		linkFile({
			target: "keymap.json",
			source: "zed/keymap.json",
			force: true,
		}),
	]);
