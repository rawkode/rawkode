package fzf

import "github.com/rawkode/rawkcue/schema"

fzf: schema.#Module & {
	name: "fzf"
	tags: ["search", "cli-tools"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "fzf"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/fzf.fish"}
			force:       true
			description: "Link fzf fish shell integration"
		},
	]
}
