import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("go")
	.description("Go programming language")
	.tags("development", "programming", "go")
	.with(() => [
		packageInstall({
			names: ["go"],
	}),
		linkDotfile({
			source: "go.fish",
		target: "fish/conf.d/go.fish",
	}),
		linkDotfile({
			source: "go.nu",
		target: "nushell/autoload/go.nu",
	}),
	]);
