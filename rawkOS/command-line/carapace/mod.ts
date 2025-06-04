import { defineModule, packageInstall, executeCommand } from "@korora-tech/dhd";

export default defineModule("carapace")
	.description("Shell completion framework")
	.with(() => [
		packageInstall({
			names: ["carapace-bin"],
		}),
		executeCommand({
			command: "nu",
			args: [
				"-c",
				'carapace _carapace nushell | save --force ($nu.user-autoload-dirs | path join "carapace.nu")',
			],
		}),
	]);
