import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("github")
	.description("GitHub CLI and configuration")
	.tags("cli", "git", "development")
	.with(() => [
		packageInstall({
			names: ["github-cli"],
		}),
		linkDotfile({
			source: "known_hosts",
			target: ".ssh/known_hosts",
			force: true,
		}),
	]);
