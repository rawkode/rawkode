export default defineModule("visual-studio-code")
	.description("Code editor")
	.tags(["desktop", "development", "editor"])
	.actions([
		packageInstall({
			names: ["visual-studio-code-bin"],
		}),
		linkDotfile({
			from: "argv.json",
			// For some weird reason, VSCode doesn't use XDG_CONFIG_HOME
			to: "~/.vscode/argv.json",
			force: true,
		}),
	]);
