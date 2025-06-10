export default defineModule("firefox")
	.description("Firefox web browser")
	.tags(["desktop", "browser", "web"])
	.actions([
		packageInstall({
			names: ["firefox-developer-edition"],
		}),
	]);
