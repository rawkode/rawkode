export default defineModule("dconf-editor")
	.description("GNOME configuration editor")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["ca.desrt.dconf-editor"],
			manager: "flatpak",
		}),
	]);
