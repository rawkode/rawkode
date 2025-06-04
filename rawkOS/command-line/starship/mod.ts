import { defineModule, packageInstall, executeCommand, linkDotfile } from "@korora-tech/dhd";

export default defineModule("starship")
	.description("Cross-shell prompt")
	.with(() => [
		packageInstall({
			names: ["starship"],
		}),
		executeCommand({
			command: "nu",
			args: [
				"-c",
				'starship init nu | save -f ($nu.user-autoload-dirs | path join "starship.nu")',
			],
		}),
		linkDotfile({
			source: "starship.fish",
			target: "fish/conf.d/starship.fish",
		}),
		linkDotfile({
			source: "config.toml",
			target: "starship.toml",
		}),
	]);
