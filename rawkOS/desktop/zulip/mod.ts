import { defineModule } from "@korora-tech/dhd/core/module-builder.ts";

export default defineModule("zulip")
	.description("Team chat")
	.tags("desktop", "communication", "chat")
	.packageInstall({
		manager: "flatpak",
		packages: ["org.zulip.Zulip"],
	})
	.build();
