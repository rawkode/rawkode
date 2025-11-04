import { defineModule, install, linkFile, source, userPath, userConfig } from "@rawkode/dhd"

export default defineModule({
	name: "ghostty",
	tags: ["terminal", "gui"],
	dependsOn: [],
	when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
	install("ghostty", { brew: "ghostty" }),

	linkFile({
		source: source("ghostty.conf"),
		target: userPath(".config/ghostty/config"),
		force: true,
		description: "Link ghostty config (macOS)",
	}),
]);
