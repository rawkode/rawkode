export default defineModule("eza")
	.description("Modern ls replacement")
	.actions([
		packageInstall({
			names: ["eza"],
		}),
		linkDotfile({
			from: "eza.fish",
			to: "fish/conf.d/eza.fish",
			force: true,
		}),
	]);
