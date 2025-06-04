import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("zulip")
	.description("Team chat")
	.tags("desktop", "communication", "chat")
	.with(() => [
		packageInstall({
			names: ["org.zulip.Zulip"],
	}),
	]);
