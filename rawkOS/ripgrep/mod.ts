export default defineModule("ripgrep")
	.description("Fast grep replacement")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["ripgrep"],
		}),
	]);
