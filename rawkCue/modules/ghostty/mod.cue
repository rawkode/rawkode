package ghostty

import "github.com/rawkode/rawkcue/schema"

ghostty: schema.#Module & {
	name: "ghostty"
	tags: ["terminal", "gui"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "ghostty", brew: "ghostty"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "ghostty.conf"}
			target:      {kind: "User", path: ".config/ghostty/config"}
			force:       true
			description: "Link ghostty config"
		},
	]
}
