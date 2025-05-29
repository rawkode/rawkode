import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("slack")
	.description("Team communication")
	.tags("desktop", "communication", "chat")
	.packageInstall({
		manager: "flatpak",
		packages: ["com.slack.Slack"],
	})
	.build();
