export default defineModule("github")
	.description("GitHub CLI and configuration")
	.tags(["terminal", "development"])
	.actions([
		packageInstall({
			names: ["github-cli"],
		}),
		linkFile({
			target: "github.nu",
			source: "nushell/autoload/github.nu",
			force: true,
		}),
	]);
