export default defineModule("zoxide")
	.description("Smart cd command")
	.actions([
		packageInstall({
			names: ["zoxide", "fzf"],
		}),
		executeCommand({
			command:
				"zoxide init nushell | save -f ($nu.user-autoload-dirs | path join 'zoxide.nu')",
			shell: "nu",
		}),
		linkDotfile({
			from: "zoxide.fish",
			to: "fish/conf.d/zoxide.fish",
			force: true,
		}),
	]);
