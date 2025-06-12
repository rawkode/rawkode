export default defineModule("zulip")
	.description("Team chat")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["org.zulip.Zulip"],
			manager: "flatpak",
		}),
	]);
