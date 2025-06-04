import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("gitbutler")
	.description("Git branch management")
	.tags("desktop", "git", "development")
	.with(() => [
		packageInstall({
			names: ["gitbutler-bin"],
	}),
	]);
