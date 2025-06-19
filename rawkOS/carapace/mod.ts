export default defineModule("carapace")
	.description("Shell completion framework")
	.tags(["terminal"])
	.actions([
		packageInstall({
			names: ["carapace-sh/carapace-bin:carapace"],
			manager: "github",
		}),
		executeCommand({
			shell: "nu",
			escalate: false,
			command:
				'carapace _carapace nushell | save --force ($nu.user-autoload-dirs | path join "carapace.nu")',
		}),
		linkFile({
			target: "init.fish",
			source: "fish/conf.d/carapace.fish",
			force: true,
		}),
	]);
