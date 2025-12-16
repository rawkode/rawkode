package fish

import "github.com/rawkode/rawkcue/schema"

fish: schema.#Module & {
	name: "fish"
	tags: ["shell", "terminal"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "fish"}]
		},
		// Auto-launch fish from bash
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "auto-fish.sh"}
			target:      {kind: "User", path: ".bashrc"}
			force:       true
			description: "Link bashrc to auto-launch fish"
		},
		// Main fish config
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "config.fish"}
			target:      {kind: "User", path: ".config/fish/config.fish"}
			force:       true
			description: "Link fish main config"
		},
		// Fish functions
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "magic-enter.fish"}
			target:      {kind: "User", path: ".config/fish/functions/magic-enter.fish"}
			force:       true
			description: "Link magic-enter function"
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "magic-enter-command.fish"}
			target:      {kind: "User", path: ".config/fish/functions/magic-enter-command.fish"}
			force:       true
			description: "Link magic-enter-command function"
		},
		// Git abbreviations
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "git-abbr.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/git-abbr.fish"}
			force:       true
			description: "Link git abbreviations"
		},
		// Nix environment integration
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "nix-env-init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/nix-env.fish"}
			force:       true
			description: "Link Nix environment integration"
		},
	]
}
