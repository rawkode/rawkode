package cuenv

import "github.com/rawkode/rawkcue/schema"

cuenv: schema.#Module & {
	name: "cuenv"
	tags: ["development", "environment"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "cuenv", brew: "cuenv/cuenv/cuenv"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/cuenv.fish"}
			force:       true
			description: "Link cuenv fish shell integration"
		},
	]
}
