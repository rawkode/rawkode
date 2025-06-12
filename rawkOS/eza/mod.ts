export default defineModule("eza")
	.description("Modern ls replacement")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["eza"],
		}),
		linkFile({
			target: "eza.fish",
			source: "fish/conf.d/eza.fish",
			force: true,
		}),
	]);
