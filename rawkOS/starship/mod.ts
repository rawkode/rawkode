export default defineModule("starship")
	.description("Cross-shell prompt")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["starship"],
		}),
		executeCommand({
			shell: "nu",
			command:
				"starship init nu | save -f ($nu.user-autoload-dirs | path join 'starship.nu')",
			escalate: false,
		}),
		linkFile({
			target: "starship.fish",
			source: "fish/conf.d/starship.fish",
			force: true,
		}),
		linkFile({
			target: "config.toml",
			source: "starship.toml",
			force: true,
		}),
	]);
