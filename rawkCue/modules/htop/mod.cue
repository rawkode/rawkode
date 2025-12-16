package htop

import "github.com/rawkode/rawkcue/schema"

htop: schema.#Module & {
	name: "htop"
	tags: ["system-monitor", "cli-tools"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "htop"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "htoprc"}
			target:      {kind: "User", path: ".config/htop/htoprc"}
			force:       true
			description: "Link htop configuration"
		},
	]
}
