package web_links

import (
	"dagger.io/dagger"
	"dagger.io/dagger/core"
	"universe.dagger.io/alpha/pulumi"
	"universe.dagger.io/bash"
	"universe.dagger.io/docker"
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
	}

	_codeWorker: core.#Source & {
		path: "./worker"
	}

	_workerDockerfile: core.#Source & {
		path: "./worker"
		include: ["Dockerfile"]
	}

	pulumiUp: pulumi.#Up & {
		stack:       "production"
		runtime:     "nodejs"
		accessToken: config.pulumi.accessToken
		source:      _codePulumi.output
	}

	buildImage: docker.#Dockerfile & {
		source: _workerDockerfile.output
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

			cargo: {
				dest:     "/src/target"
				contents: core.#CacheDir & {
					id: "web-links-worker-cargo-cache"
				}
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

			cargo: {
				dest:     "/src/target"
				contents: core.#CacheDir & {
					id: "web-links-worker-cargo-cache"
				}
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
			yarn run publish
			"""
	}
}
