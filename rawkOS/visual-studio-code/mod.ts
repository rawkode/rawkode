export default defineModule("visual-studio-code")
	.description("Code editor")
	.tags(["desktop", "development"])
	.actions([
		packageInstall({
			names: ["visual-studio-code-bin"],
		}),
		linkFile({
			target: "argv.json",
			// For some weird reason, VSCode doesn't use XDG_CONFIG_HOME
			source: "~/.vscode/argv.json",
			force: true,
		}),
	]);
