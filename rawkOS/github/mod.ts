export default defineModule("github")
	.description("GitHub CLI and configuration")
	.tags(["terminal", "development"])
	.actions([
		packageInstall({
			names: ["github-cli"],
		}),
	]);
