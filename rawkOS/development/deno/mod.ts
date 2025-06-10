export default defineModule("deno")
	.description("Deno JavaScript runtime")
	.tags(["development", "programming", "javascript", "typescript"])
	.actions([
		linkDotfile({
			from: "deno.fish",
			to: "fish/conf.d/deno.fish",
			force: true,
		}),
	]);
