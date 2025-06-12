export default defineModule("atuin")
	.description("Sync, search and backup shell history with Atuin")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["atuin"],
		}),
		linkFile({
			source: "config.toml",
			target: "atuin/config.toml",
			force: true,
		}),
		linkFile({
			source: "atuin.fish",
			target: "fish/conf.d/atuin.fish",
			force: true,
		}),
		executeCommand({
			shell: "nu",
			command:
				"atuin init nu | save -f ($nu.user-autoload-dirs | path join 'atuin.nu')",
			escalate: false,
		}),
	]);
