package helix

import "github.com/rawkode/rawkcue/schema"

helix: schema.#Module & {
	name: "helix"
	tags: ["editor", "development"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		// Install helix editor
		schema.#Install & {
			type: "install"
			packages: [{default: "helix", brew: "helix"}]
		},
		// Install language servers and tools
		schema.#Install & {
			type: "install"
			packages: [
				{default: "biome"},
				{default: "helix-gpt"},
				{default: "bash-language-server"},
				{default: "dockerfile-language-server-nodejs"},
				{default: "taplo"},
				{default: "yaml-language-server"},
				{default: "prettier"},
				{default: "sql-formatter"},
			]
		},
		// Link helix config
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "config.toml"}
			target:      {kind: "User", path: ".config/helix/config.toml"}
			force:       true
			description: "Link helix editor config"
		},
		// Link languages config
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "languages.toml"}
			target:      {kind: "User", path: ".config/helix/languages.toml"}
			force:       true
			description: "Link helix languages config"
		},
		// Display LSP installation note
		schema.#RunCommand & {
			type:        "runCommand"
			command:     "echo \"Note: Some language servers require manual installation. See mod.cue for details.\""
			description: "Display LSP installation note"
		},
	]
}
