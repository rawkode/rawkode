export default defineModule("espanso")
	.description("Text expander")
	.actions([
		packageInstall({
			names: ["espanso-wayland"],
		}),
		linkDotfile({
			from: "config",
			to: "espanso/config",
			force: true,
		}),
		linkDotfile({
			from: "match",
			to: "espanso/match",
			force: true,
		}),
		executeCommand({
			command: "systemctl",
			args: ["--user", "enable", "--now", "espanso.service"],
		}),
	]);
