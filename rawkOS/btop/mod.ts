export default defineModule("btop")
	.description("Resource monitor")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["btop"],
		}),
	]);
