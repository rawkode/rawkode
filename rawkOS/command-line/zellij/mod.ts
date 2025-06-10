export default defineModule("zellij")
	.description("Terminal multiplexer")
	.tags(["cli", "terminal", "multiplexer"])
	.actions([
		packageInstall({
			names: ["zellij"],
		}),
		linkDotfile({
			from: "config.kdl",
			to: "zellij/config.kdl",
			force: true,
		}),
		linkDotfile({
			from: "zellij.fish",
			to: "fish/conf.d/zellij.fish",
			force: true,
		}),
	]);
