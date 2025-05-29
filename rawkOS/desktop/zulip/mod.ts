import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("zulip")
	.description("Team chat")
	.tags("desktop", "communication", "chat")
	.packageInstall({
		manager: "flatpak",
		packages: ["org.zulip.Zulip"],
	})
	.build();
