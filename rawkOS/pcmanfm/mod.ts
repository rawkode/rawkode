export default defineModule("pcmanfm")
	.description("PCManFM file manager")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["pcmanfm-gtk3"],
		}),
	]);
