import {
	defineModule,
	packageInstall,
	linkDotfile,
	executeCommand,
} from "@korora-tech/dhd";

export default defineModule("atuin")
	.description("Sync, search and backup shell history with Atuin")
	.with(() => [
		packageInstall({
			names: ["atuin"],
		}),
		linkDotfile({
			source: "config.toml",
			target: "atuin/config.toml",
		}),
		executeCommand({
			shell: "nu",
			command:
				"atuin init nu | save -f ($nu.user-autoload-dirs | path join 'atuin.nu')",
		}),
	]);
