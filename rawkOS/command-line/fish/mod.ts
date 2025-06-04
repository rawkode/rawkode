import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";

export default defineModule("fish")
	.description("Fish shell configuration")
	.with(() => [
		packageInstall({
			names: ["fish"],
		}),
		linkDotfile({
			source: "magic-enter.fish",
			target: "fish/conf.d/magic-enter.fish",
		}),
		linkDotfile({
			source: "aliases.fish",
			target: "fish/conf.d/aliases.fish",
		}),
	]);
