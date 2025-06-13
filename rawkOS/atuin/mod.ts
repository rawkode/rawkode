export default defineModule("atuin")
	.description("Sync, search and backup shell history with Atuin")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["atuin"],
		}),
		linkFile({
			target: "config.toml",
			source: "atuin/config.toml",
			force: true,
		}),
		linkFile({
			target: "atuin.fish",
			source: "fish/conf.d/atuin.fish",
			force: true,
		}),
		executeCommand({
			shell: "nu",
			command:
				"atuin init nu | save -f ($nu.user-autoload-dirs | path join 'atuin.nu')",

			escalate: false,
		}),
	]);

