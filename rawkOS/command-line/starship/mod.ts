export default defineModule("starship")
	.description("Cross-shell prompt")
	.actions([
		packageInstall({
			names: ["starship"],
		}),
		executeCommand({
			command:
				"starship init nu | save -f ($nu.user-autoload-dirs | path join 'starship.nu')",
			shell: "nu",
			escalate: false,
		}),
		linkDotfile({
			from: "starship.fish",
			to: "fish/conf.d/starship.fish",
			force: true,
		}),
		linkDotfile({
			from: "config.toml",
			to: "starship.toml",
			force: true,
		}),
	]);
