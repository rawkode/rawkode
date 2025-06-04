import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("eza")
	.description("Modern ls replacement")
	.with(() => [
		packageInstall({
			names: ["eza"],
		}),
		linkDotfile({
			source: "eza.fish",
			target: "fish/conf.d/eza.fish",
		}),
	]);
