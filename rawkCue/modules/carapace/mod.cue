package carapace

import "github.com/rawkode/rawkcue/schema"

carapace: schema.#Module & {
	name: "carapace"
	tags: ["shell", "completions"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "carapace"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/carapace.fish"}
			force:       true
			description: "Link carapace fish shell integration"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.nu"}
			target:      {kind: "User", path: ".config/nushell/scripts/carapace.nu"}
			force:       true
			description: "Link carapace nushell integration"
		},
	]
}
