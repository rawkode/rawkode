package cuenv

import "github.com/cuenv/cuenv/schema"

env: NIX_CONFIG: [
	"access-tokens = github.com=",
	schema.#ExecSecret & {command: "gh", args: ["auth", "token"]},
]
