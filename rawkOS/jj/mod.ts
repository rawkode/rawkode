export default defineModule("jj")
	.description("Jujutsu version control")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["jujutsu"],
		}),
		linkFile({
			target: "config.toml",
			source: "jj/config.toml",
			force: true,
		}),
	]);
