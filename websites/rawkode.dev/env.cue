package cuenv

import (
	"github.com/cuenv/cuenv/schema"
)

schema.#Project

name: "rawkode.dev"


env: {
	environment: production: {
		CLOUDFLARE_ACCOUNT_ID: "0aeb879de8e3cdde5fb3d413025222ce"
        	CLOUDFLARE_API_TOKEN: schema.#OnePasswordRef & {ref: "op://sa.rawkode.academy/cloudflare/api-tokens/workers"}
	}
}

