package ripgrep

import "github.com/rawkode/rawkcue/schema"

ripgrep: schema.#Module & {
	name: "ripgrep"
	tags: ["search", "cli-tools"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "ripgrep"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "ripgreprc"}
			target:      {kind: "User", path: ".config/ripgrep/ripgreprc"}
			force:       true
			description: "Link ripgrep configuration"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/ripgrep.fish"}
			force:       true
			description: "Link ripgrep fish shell integration"
		},
	]
}
