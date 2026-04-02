@extern(embed)

package cuenv

import "github.com/cuenv/cuenv/schema"

schema.#Project & {
	name: "nix"

	env: NIX_CONFIG: [
		"access-tokens = github.com=",
		schema.#ExecSecret & {command: "gh", args: ["auth", "token"]},
	]

	tasks: {
		update: schema.#Task & {
			description: "Update all flake inputs except excluded ones"
			script:      _ @embed(file=scripts/update.nu,type=text)
			scriptShell: "nu"
			hermetic:    false
		}

		"bootstrap-cache": schema.#Task & {
			description: "Seed trusted users and binary cache config directly into the active daemon before the first switch"
			script:      _ @embed(file=scripts/bootstrap-cache.nu,type=text)
			scriptShell: "nu"
			hermetic:    false
		}
	}
}
