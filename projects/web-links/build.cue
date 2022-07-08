package web_links

import (
	"dagger.io/dagger"
	"dagger.io/dagger/core"
	"universe.dagger.io/alpha/pulumi"
	"universe.dagger.io/alpine"
	"universe.dagger.io/bash"
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
			"./Dockerfile",
			"./node_modules",
		]
	}

	_workerDockerfile: core.#Source & {
		path: "./worker"
		include: ["Dockerfile"]
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

	buildImage: alpine.#Build & {
		packages: {
			bash: {}
			yarn: {}
			git: {}
		}
	}

	savePassword: bash.#Run & {
		input: buildImage.output

		env: {
			CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId
			if config.cloudflare.apiToken != _|_ {
				CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken
			}

			PASSWORD: pulumiUp.output.password.contents
		}

		mounts: {
			"src": {
				contents: _codeWorker.output
				dest:     "/src"
			}

			node_modules: {
				dest:     "/src/node_modules"
				contents: core.#CacheDir & {
					id: "web-links-worker-npm-cache"
				}
			}
		}

		workdir: "/src"

		script: contents: """
			set -x
			yarn install
			echo "${PASSWORD}" | yarn run wrangler secret put ANALYTICS_PASSWORD
			"""
	}

	deploy: bash.#Run & {
		input: buildImage.output
		mounts: {
			source: {
				contents: _codeWorker.output
				dest:     "/src"
			}

			node_modules: {
				dest:     "/src/node_modules"
				contents: core.#CacheDir & {
					id: "web-links-worker-npm-cache"
				}
			}
		}

		workdir: "/src"

		env: {
			CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId
			if config.cloudflare.apiToken != _|_ {
				CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken
			}
			ENDPOINT:  pulumiUp.output.endpoint.contents
			NAMESPACE: pulumiUp.output.namespace.contents
			TOPIC:     pulumiUp.output.topic.contents
			USERNAME:  pulumiUp.output.username.contents
		}
		script: contents: """
			set -x
			cat <<EOF >> wrangler.toml
			ANALYTICS_HOST = "${ENDPOINT}"
			ANALYTICS_NAMESPACE = "${NAMESPACE}"
			ANALYTICS_TOPIC = "${TOPIC}"
			ANALYTICS_USER = "${USERNAME}"
			EOF

			yarn install
			yarn run wrangler publish src/index.ts
			"""
	}
}
