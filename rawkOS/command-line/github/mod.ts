export default defineModule("github")
	.description("GitHub CLI and configuration")
	.tags(["cli", "git", "development"])
	.actions([
		packageInstall({
			names: ["github-cli"],
		}),
		linkDotfile({
			from: "known_hosts",
			to: ".ssh/known_hosts",
			force: true,
		}),
	]);
