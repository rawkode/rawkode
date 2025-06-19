export default defineModule("slack")
	.description("Team communication")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["com.slack.Slack"],
			manager: "flatpak",
		}),
		linkFile({
			target: "wayland.conf",
			source: "~/.local/share/flatpak/overrides/com.slack.Slack",
			force: true,
		}),
	]);
