export default defineModule("carapace")
	.description("Shell completion framework")
	.actions([
		packageInstall({
			names: ["carapace-bin"],
		}),
		executeCommand({
			shell: "nu",
			command:
				"carapace _carapace nushell | save --force ($nu.user-autoload-dirs | path join 'carapace.nu')",
		}),
	]);
