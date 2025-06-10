export default defineModule("atuin")
	.description("Sync, search and backup shell history with Atuin")
	.actions([
		packageInstall({
			names: ["atuin"],
		}),
		linkDotfile({
			to: "atuin/config.toml",
			from: "config.toml",
			force: true,
		}),
		linkDotfile({
			to: "fish/conf.d/atuin.fish",
			from: "atuin.fish",
			force: true,
		}),
	]);
