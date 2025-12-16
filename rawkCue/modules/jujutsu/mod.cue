package jujutsu

import "github.com/rawkode/rawkcue/schema"

jujutsu: schema.#Module & {
	name: "jujutsu"
	tags: ["vcs", "development"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "jujutsu", brew: "jj"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "config.toml"}
			target:      {kind: "User", path: ".config/jj/config.toml"}
			force:       true
			description: "Link jujutsu configuration"
		},
	]
}
