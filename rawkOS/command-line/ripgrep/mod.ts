export default defineModule("ripgrep")
	.description("Fast grep replacement")
	.actions([
		packageInstall({
			names: ["ripgrep"],
		}),
	]);
