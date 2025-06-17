export default defineModule("llm")
	.description("llm CLI tool")
	.tags(["ai", "terminal"])
	.actions([
		packageInstall({
			names: ["llm"],
			manager: "uv",
		}),
		executeCommand({
			command: "llm install llm-gemini",
		}),
		executeCommand({
			command: "llm models default gemini-2.5-flash-preview-05-20",
		}),
	]);
