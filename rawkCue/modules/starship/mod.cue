package starship

import "github.com/rawkode/rawkcue/schema"

starship: schema.#Module & {
	name: "starship"
	tags: ["terminal"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "starship"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "starship.toml"}
			target:      {kind: "User", path: ".config/starship.toml"}
			force:       true
			description: "Link starship config"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "starship.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/starship.fish"}
			force:       true
			description: "Link starship fish integration"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "starship.nu"}
			target:      {kind: "User", path: ".config/nushell/conf.d/starship.nu"}
			force:       true
			description: "Link starship nushell integration"
		},
	]
}
