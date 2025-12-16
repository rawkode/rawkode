package zoxide

import "github.com/rawkode/rawkcue/schema"

zoxide: schema.#Module & {
	name: "zoxide"
	tags: ["shell", "navigation"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "zoxide"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/zoxide.fish"}
			force:       true
			description: "Link zoxide fish shell integration"
		},
	]
}
