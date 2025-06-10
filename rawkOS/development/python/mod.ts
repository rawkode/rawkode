export default defineModule("python")
	.description("Python programming language")
	.tags(["development", "programming", "python"])
	.actions([
		packageInstall({
			names: ["uv"],
		}),
	]);
