package github

import "github.com/rawkode/rawkcue/schema"

github: schema.#Module & {
	name: "github"
	tags: ["git", "development"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "gh"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "config.yml"}
			target:      {kind: "User", path: ".config/gh/config.yml"}
			force:       true
			description: "Link GitHub CLI configuration"
		},
	]
}
