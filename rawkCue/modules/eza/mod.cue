package eza

import "github.com/rawkode/rawkcue/schema"

eza: schema.#Module & {
	name: "eza"
	tags: ["file-manager", "cli-tools"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "eza"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/eza.fish"}
			force:       true
			description: "Link eza fish shell integration"
		},
	]
}
