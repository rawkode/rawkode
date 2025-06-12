export default defineModule("bat")
	.description("Cat replacement with syntax highlighting")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["bat"],
		}),
	]);
