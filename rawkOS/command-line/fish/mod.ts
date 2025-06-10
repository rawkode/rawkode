export default defineModule("fish")
	.description("Fish shell configuration")
	.actions([
		packageInstall({
			names: ["fish"],
		}),
		linkDotfile({
			from: "magic-enter.fish",
			to: "fish/conf.d/magic-enter.fish",
			force: true,
		}),
		linkDotfile({
			from: "aliases.fish",
			to: "fish/conf.d/aliases.fish",
			force: true,
		}),
	]);
