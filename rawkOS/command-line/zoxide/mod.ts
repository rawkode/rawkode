import {
	defineModule,
	executeCommand,
	packageInstall,
	linkDotfile,
} from "@korora-tech/dhd";

export default defineModule("zoxide")
	.description("Smart cd command")
	.with(() => [
		packageInstall({
			names: ["zoxide", "fzf"],
		}),
		executeCommand({
			command:
				"zoxide init nushell | save -f ($nu.user-autoload-dirs | path join 'zoxide.nu')",
			shell: "nu",
		}),
		linkDotfile({
			source: "zoxide.fish",
			target: "fish/conf.d/zoxide.fish",
		}),
	]);
