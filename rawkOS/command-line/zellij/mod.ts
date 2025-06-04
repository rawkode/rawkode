import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("zellij")
	.description("Terminal multiplexer")
	.tags("cli", "terminal", "multiplexer")
	.with(() => [
		packageInstall({
			names: ["zellij"],
	}),
		linkDotfile({
			source: "config.kdl",
		target: "zellij/config.kdl",
	}),
		linkDotfile({
			source: "zellij.nu",
		target: "nushell/autoload/zellij.nu",
	}),
	]);
