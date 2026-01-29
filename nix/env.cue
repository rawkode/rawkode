package cuenv

import "github.com/cuenv/cuenv/schema"

env: GH_AUTH_TOKEN: schema.#OnePasswordRef & { ref: "op://Private/GitHub/api-tokens/no-permissions-just-auth" }
env: NIX_CONFIG: "access-tokens = github.com=\(env.GH_AUTH_TOKEN)"
