export default defineModule("deno")
	.description("Deno JavaScript runtime")
	.tags(["development"])
	.actions([
		linkFile({
			target: "deno.fish",
			source: "fish/conf.d/deno.fish",
			force: true,
		}),
	]);
