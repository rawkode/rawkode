export default defineModule("fonts")
	.description("System fonts")
	.tags(["system"])
	.actions([
		packageInstall({
			names: ["otf-monaspace", "otf-monaspace-nerd"],
		}),
	]);
