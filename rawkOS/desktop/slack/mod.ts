import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("slack")
	.description("Team communication")
	.tags("desktop", "communication", "chat")
	.with(() => [
		packageInstall({
			names: ["com.slack.Slack"],
	}),
	]);
