import { defineModule, packageInstall, linkDotfile, executeCommand } from "@korora-tech/dhd";

export default defineModule("espanso")
	.description("Text expander")
	.with(() => [
		packageInstall({
			names: ["espanso-wayland"],
		}),
		linkDotfile({
			source: "config",
			target: "espanso/config",
		}),
		linkDotfile({
			source: "match",
			target: "espanso/match",
		}),
		executeCommand({
			command: "systemctl",
			args: ["--user", "enable", "--now", "espanso.service"],
		}),
	]);
