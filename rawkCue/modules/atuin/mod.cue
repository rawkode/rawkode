package atuin

import "github.com/rawkode/rawkcue/schema"

atuin: schema.#Module & {
	name: "atuin"
	tags: ["shell", "history"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "atuin"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "config.toml"}
			target:      {kind: "User", path: ".config/atuin/config.toml"}
			force:       true
			description: "Link atuin configuration"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/atuin.fish"}
			force:       true
			description: "Link atuin fish shell integration"
		},
	]
}
