export default defineModule("zellij")
	.description("Terminal multiplexer")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["zellij"],
		}),
		linkFile({
			target: "config.kdl",
			source: "zellij/config.kdl",
			force: true,
		}),
		linkFile({
			target: "zellij.nu",
			source: "nushell/autoload/zellij.nu",
			force: true,
		}),
		linkFile({
			target: "zellij.fish",
			source: "fish/conf.d/zellij.fish",
			force: true,
		}),
	]);
