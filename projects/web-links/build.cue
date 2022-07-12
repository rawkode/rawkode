package web_links

import (
	"dagger.io/dagger"
	"dagger.io/dagger/core"
	"universe.dagger.io/alpha/pulumi"
	"universe.dagger.io/yarn"
)

#Build: {
	config: {
		cloudflare: {
			apiToken:  dagger.#Secret | *""
			accountId: string
		}
		pulumi: {
			accessToken: dagger.#Secret
		}
	}

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
		accessToken: config.pulumi.accessToken
		source:      _codePulumi.output

		container: env: {
			CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId
			CLOUDFLARE_API_TOKEN:  config.cloudflare.apiToken
		}
	}

	wranglerPublish: yarn.#Script & {
		name:    "publish"
		project: "web-vanity-links"
		source:  _codeWorker.output

		container: env: {
			CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId
			CLOUDFLARE_API_TOKEN:  config.cloudflare.apiToken
		}
	}
}
