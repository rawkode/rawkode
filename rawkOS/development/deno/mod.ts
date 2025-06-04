import { defineModule, linkDotfile } from "@korora-tech/dhd";

export default defineModule("deno")
	.description("Deno JavaScript runtime")
	.tags("development", "programming", "javascript", "typescript")
	.with(() => [
		linkDotfile({
			source: "deno.fish",
		target: "fish/conf.d/deno.fish",
	}),
	]);
