export default defineModule("fonts")
	.description("System fonts")
	.actions([
		packageInstall({
			names: ["otf-monaspace", "otf-monaspace-nerd"],
		}),
	]);
