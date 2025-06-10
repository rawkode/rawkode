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
		// TODO: Need the ability to enable / disable a service without
		// defining the actual service
		executeCommand({
			command: "systemctl",
			args: ["--user", "enable", "--now", "espanso.service"],
			// TODO: Should be an optional property, defaulting to false
			escalate: false,
		}),
	]);
