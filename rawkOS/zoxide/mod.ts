export default defineModule("zoxide")
	.description("Smart cd command")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["zoxide", "fzf"],
		}),
		executeCommand({
			shell: "nu",
			command:
				"zoxide init nushell --cmd cd | save -f ($nu.user-autoload-dirs | path join 'zoxide.nu')",
			escalate: false,
		}),
		linkFile({
			source: "zoxide.fish",
			target: "fish/conf.d/zoxide.fish",
			force: true,
		}),
	]);
