import { defineModule } from "@rawkode/dhd/core/module-builder.ts";

export default defineModule("wallpapers")
	.description("Desktop wallpapers")
	.tags("desktop", "customization")
	.symlink({
		source: "rawkode-academy.png",
		target: ".config/wallpapers/rawkode-academy.png",
	})
	.build();
