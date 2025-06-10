export default defineModule("pcmanfm")
	.description("PCManFM file manager")
	.tags(["desktop", "file-manager"])
	.actions([
		packageInstall({
			names: ["pcmanfm-gtk3"],
		}),
	]);
