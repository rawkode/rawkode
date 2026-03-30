@extern(embed)

package cuenv

import "github.com/cuenv/cuenv/schema"

env: NIX_CONFIG: [
	"access-tokens = github.com=",
	schema.#ExecSecret & {command: "gh", args: ["auth", "token"]},
]

tasks: update: schema.#Task & {
	description: "Update all flake inputs except excluded ones"
	script:      _ @embed(file=scripts/update.nu,type=text)
	scriptShell: "nu"
	hermetic:    false
}
