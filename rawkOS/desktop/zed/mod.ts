import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("zed")
	.description("Code editor")
	.tags("desktop", "development", "editor")
	.with(() => [
		packageInstall({
			names: ["zed"],
	}),
		linkDotfile({
			source: "keymap.json",
		target: "zed/keymap.json",
	}),
		linkDotfile({
			source: "settings.json",
		target: "zed/settings.json",
	}),
	]);
