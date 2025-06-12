export default defineModule("espanso")
	.description("Text expander")
	.tags(["desktop"])
	.actions([
		packageInstall({
			names: ["espanso-wayland"],
		}),
		linkFile({
			target: "config",
			source: "espanso/config",
			force: true,
		}),
		linkFile({
			target: "match",
			source: "espanso/match",
			force: true,
		}),
		systemdManage({
			name: "espanso.service",
			operation: "enable",
			scope: "user",
		}),
		systemdManage({
			name: "espanso.service",
			operation: "start",
			scope: "user",
		}),
	]);
