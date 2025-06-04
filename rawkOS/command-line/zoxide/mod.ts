import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("zoxide")
	.description("Smart cd command")
	.tags("cli", "navigation")
	.with(() => [
		packageInstall({
			names: ["zoxide", "fzf"],
	}),
		linkDotfile({
			source: "zoxide.fish",
		target: "fish/conf.d/zoxide.fish",
	}),
	]);
