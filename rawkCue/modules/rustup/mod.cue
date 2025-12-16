package rustup

import "github.com/rawkode/rawkcue/schema"

rustup: schema.#Module & {
	name: "rustup"
	tags: ["rust", "toolchain"]
	when: [{platformIn: ["linux", "darwin"]}]

	actions: [
		schema.#Install & {
			type: "install"
			packages: [{default: "rustup"}]
		},
		schema.#LinkFile & {
			type:        "linkFile"
			source:      {kind: "Source", relativePath: "init.fish"}
			target:      {kind: "User", path: ".config/fish/conf.d/rustup.fish"}
			force:       true
			description: "Link rustup fish shell integration"
		},
	]
}
