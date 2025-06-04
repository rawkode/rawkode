import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("jj")
	.description("Jujutsu version control")
	.tags("cli", "vcs", "development")
	.with(() => [
		packageInstall({
			names: ["jujutsu"],
	}),
		linkDotfile({
			source: "config.toml",
		target: "jj/config.toml",
	}),
	]);
