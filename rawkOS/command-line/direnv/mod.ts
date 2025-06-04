import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("direnv")
	.description("Directory-based environment variables")
	.with(() => [
		packageInstall({
			names: ["direnv"],
		}),
		linkDotfile({
			source: "direnv.fish",
			target: "fish/conf.d/direnv.fish",
		}),
		linkDotfile({
			source: "direnv.nu",
			target: "nushell/autoload/direnv.nu",
		}),
	]);
