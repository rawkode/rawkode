export default defineModule("vivid")
	.description("LS_COLORS generator")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["vivid"],
		}),
	]);
