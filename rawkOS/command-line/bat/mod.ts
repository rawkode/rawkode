export default defineModule("bat")
	.description("Cat replacement with syntax highlighting")
	.actions([
		packageInstall({
			names: ["bat"],
		}),
	]);
