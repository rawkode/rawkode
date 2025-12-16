package bun

import "github.com/rawkode/rawkcue/schema"

bun: schema.#Module & {
	name: "bun"
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "bun"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/bun.fish"}
			force:       true
			description: "Link Bun fish shell integration"
		},
	]
}
