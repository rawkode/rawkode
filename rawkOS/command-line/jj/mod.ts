export default defineModule("jj")
	.description("Jujutsu version control")
	.tags(["cli", "vcs", "development"])
	.actions([
		packageInstall({
			names: ["jujutsu"],
		}),
		linkDotfile({
			from: "config.toml",
			to: "jj/config.toml",
			force: true,
		}),
	]);
