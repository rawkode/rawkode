import { defineModule, packageInstall, linkDotfile } from "@korora-tech/dhd";
import { conditions } from "@korora-tech/dhd";

export default defineModule("waybar")
	.description("Wayland bar")
	.tags("desktop", "wayland", "bar")
	.with(() => [
		packageInstall({
			names: ["waybar", "helvum"],
	}),
		linkDotfile({
			source: "config",
		target: "waybar/config",
	}),
		linkDotfile({
			source: "style.css",
		target: "waybar/style.css",
	}),
	]);
