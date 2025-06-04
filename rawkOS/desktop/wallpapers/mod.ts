import { defineModule, linkDotfile } from "@korora-tech/dhd";

export default defineModule("wallpapers")
	.description("Desktop wallpapers")
	.tags("desktop", "customization")
	.with(() => [
		linkDotfile({
			source: "rawkode-academy.png",
		target: "wallpapers/rawkode-academy.png",
	}),
	]);
