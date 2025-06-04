import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("bun")
	.description("Bun TypeScript runtime")
	.tags("development", "programming")
	.with(() => [
		packageInstall({
			names: ["bun-bin"],
		}),
		linkDotfile({
			source: "bun.nu",
			target: "nushell/autoload/bun.nu",
		}),
	]);
