export default defineModule("firefox")
	.description("Firefox web browser")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["firefox-developer-edition"],
		}),
	]);
