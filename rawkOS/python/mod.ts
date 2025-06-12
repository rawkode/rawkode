export default defineModule("python")
	.description("Python programming language")
	.tags(["development"])
	.actions([
		packageInstall({
			names: ["uv"],
		}),
	]);
