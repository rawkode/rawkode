export default defineModule("zulip")
	.description("Team chat")
	.tags(["desktop", "communication"])
	.actions([
		packageInstall({
			names: ["org.zulip.Zulip"],
			manager: "flatpak",
		}),
	]);
