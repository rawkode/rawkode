export default defineModule("btop")
	.description("Resource monitor")
	.actions([
		packageInstall({
			names: ["btop"],
		}),
	]);
