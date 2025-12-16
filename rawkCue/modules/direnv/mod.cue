package direnv

import "github.com/rawkode/rawkcue/schema"

direnv: schema.#Module & {
	name: "direnv"
	tags: ["development", "environment"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "direnv"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/direnv.fish"}
			force:       true
			description: "Link direnv fish shell integration"
		},
	]
}
