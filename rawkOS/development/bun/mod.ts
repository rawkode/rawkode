export default defineModule("bun")
	.description("Bun TypeScript runtime")
	.tags(["development", "programming"])
	.actions([
		packageInstall({
			names: ["bun-bin"],
		}),
		// TODO add path to fish
		linkDotfile({
			from: "bun.nu",
			to: "nushell/autoload/bun.nu",
			force: true,
		}),
	]);
