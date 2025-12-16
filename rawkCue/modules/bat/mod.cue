package bat

import "github.com/rawkode/rawkcue/schema"

bat: schema.#Module & {
	name: "bat"
	tags: ["file-viewer", "cli-tools"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "bat"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "config"}
			target:      {kind: "User", path: ".config/bat/config"}
			force:       true
			description: "Link bat configuration"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/bat.fish"}
			force:       true
			description: "Link bat fish shell integration"
		},
	]
}
