export default defineModule("vivid")
	.description("LS_COLORS generator")
	.tags(["cli", "utilities", "colors"])
	.actions([
		packageInstall({
			names: ["vivid"],
		}),
	]);
