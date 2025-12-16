package go

import "github.com/rawkode/rawkcue/schema"

go: schema.#Module & {
	name: "go"
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "go"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/go.fish"}
			force:       true
			description: "Link Go fish shell integration"
		},
	]
}
