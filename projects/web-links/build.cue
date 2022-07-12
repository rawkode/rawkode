package web_links

import (
	"dagger.io/dagger"
	"dagger.io/dagger/core"
	"universe.dagger.io/alpha/pulumi"
	"universe.dagger.io/yarn"
)

config: {
	cloudflare: {
		accountId: string
		apiToken:  dagger.#Secret
	}
	pulumi: {
		accessToken: dagger.#Secret
	}
}

actions: {
	_codePulumi: core.#Source & {
		path: "./pulumi"
		exclude: [
			"./node_modules",
		]
	}

	_codeWorker: core.#Source & {
		path: "./worker"
		exclude: [
			"./node_modules",
		]
	}

	pulumiUp: pulumi.#Up & {
		stack:       "production"
		runtime:     "nodejs"
		refresh:     true
		accessToken: config.pulumi.accessToken
		source:      _codePulumi.output

		container: env: {
			CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId
			if config.cloudflare.apiToken != _|_ {
				CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken
			}
		}
	}

	wranglerPublish: yarn.#Script & {
		name:   "publish"
		source: _codeWorker.output

		container: env: {
			CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId
			if config.cloudflare.apiToken != _|_ {
				CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken
			}
		}
	}
}
