export default defineModule("dconf-editor")
	.description("GNOME configuration editor")
	.tags(["desktop", "configuration"])
	.actions([
		packageInstall({
			names: ["ca.desrt.dconf-editor"],
		}),
	]);
