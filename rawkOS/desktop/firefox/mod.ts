import { defineModule, packageInstall } from "@korora-tech/dhd";

export default defineModule("firefox")
	.description("Firefox web browser")
	.tags("desktop", "browser", "web")
	.with(() => [
		packageInstall({
			names: ["firefox-developer-edition"],
	}),
	]);
