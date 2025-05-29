import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("deno")
	.description("Deno JavaScript runtime")
	.tags("development", "programming", "javascript", "typescript")
	.symlink({
		source: "deno.fish",
		target: ".config/fish/conf.d/deno.fish",
	})
	.build();
