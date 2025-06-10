export default defineModule("darkman")
	.description("Darkman - A dark mode switcher for Linux")
	.actions([
		packageInstall({
			names: ["darkman"],
		}),
		linkDotfile({
			to: "darkman/config.toml",
			from: "config.toml",
			force: true,
		}),
		linkDirectory({
			to: "darkman/light-mode.d",
			from: "darkman/light-mode.d",
			force: true,
		}),
		linkDirectory({
			to: "darkman/dark-mode.d",
			from: "darkman/dark-mode.d",
			force: true,
		}),
	]);
