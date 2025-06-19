export default defineModule("bun")
	.description("Bun TypeScript runtime")
	.tags(["development"])
	.actions([
		packageInstall({
			names: ["bun-bin"],
		}),
		// TODO add path to fish
		linkFile({
			target: "bun.nu",
			source: "nushell/autoload/bun.nu",
			force: true,
		}),
		linkFile({
			target: "init.fish",
			source: "fish/conf.d/bun.fish",
			force: true,
		}),
	]);
