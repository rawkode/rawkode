export default defineModule("fish")
	.description("Fish shell configuration")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["fish"],
		}),
		linkFile({
			target: "magic-enter.fish",
			source: "fish/conf.d/magic-enter.fish",
			force: true,
		}),
		linkFile({
			target: "aliases.fish",
			source: "fish/conf.d/aliases.fish",
			force: true,
		}),
	]);
