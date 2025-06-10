export default defineModule("slack")
	.description("Team communication")
	.tags(["desktop", "communication", "chat"])
	.actions([
		packageInstall({
			names: ["com.slack.Slack"],
		}),
	]);
