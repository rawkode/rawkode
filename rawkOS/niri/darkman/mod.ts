export default defineModule("darkman")
	.description("Darkman - A dark mode switcher for Linux")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["darkman"],
		}),
		linkFile({
			source: "darkman/config.yaml",
			target: "config.yaml",
			force: true,
		}),
		linkDirectory({
			source: "darkman/light-mode.d",
			target: "light-mode.d",
			force: true,
		}),
		linkDirectory({
			source: "darkman/dark-mode.d",
			target: "dark-mode.d",
			force: true,
		}),
	]);
