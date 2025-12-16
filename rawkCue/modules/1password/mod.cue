package onepassword

import (
	"list"

	"github.com/rawkode/rawkcue/schema"
	"github.com/rawkode/rawkcue/schema/helpers"
)

let _shellIntegration = (helpers.#ShellIntegration & {opts: {
	tool: "1password"
	fish: "init.fish"
	zsh:  "init.zsh"
}}).out

"1password": schema.#Module & {
	name: "1password"
	tags: ["security", "password-manager", "cli"]
	when: [{platformIn: ["darwin"]}]

	actions: list.Concat([
		[
			// GUI app (macOS)
			schema.#Install & {
				type:     "install"
				packages: [{default: "1password", brew: "1password"}]
			},
			// CLI
			schema.#Install & {
				type:     "install"
				packages: [{default: "op", brew: "1password-cli"}]
			},
		],
		_shellIntegration,
	])
}
