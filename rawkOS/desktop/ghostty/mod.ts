import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("ghostty")
	.description("GPU-accelerated terminal")
	.tags("desktop", "terminal")
	.with(() => [
		packageInstall({
			names: ["ghostty"],
	}),
		linkDotfile({
			source: "config.ini",
		target: "ghostty/config",
	}),
	]);
