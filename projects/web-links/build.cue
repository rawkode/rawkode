package web_links

import (
	"dagger.io/dagger"
	"dagger.io/dagger/core"
	"universe.dagger.io/alpha/pulumi"
	"universe.dagger.io/bash"
	"universe.dagger.io/docker"
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
	}

	_codeWorker: core.#Source & {
		path: "./worker"
	}

	pulumiUp: pulumi.#Up & {
		stack:       "production"
		runtime:     "nodejs"
		accessToken: config.pulumi.accessToken
		source:      _codePulumi.output
	}

	_buildImage: docker.#Dockerfile & {
		source: _codeWorker.output
	}

	savePassword: bash.#Run & {
		input: _buildImage.output

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

	writeConfig: bash.#Run & {
		input: _buildImage.output
		mounts: "src": {
			contents: _codeWorker.output
			dest:     "/src"
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
			[vars]
			ANALYTICS_HOST = "${ENDPOINT}"
			ANALYTICS_NAMESPACE = "${NAMESPACE}"
			ANALYTICS_TOPIC = "${TOPIC}"
			ANALYTICS_USER = "${USERNAME}"
			EOF
			"""
	}

	deploy: yarn.#Script & {
		container: input: _buildImage.output
		source: _codeWorker.output
		name:   "publish"
		container: {
			mounts: {
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

			env: {
				if config.cloudflare.apiToken != _|_ {
					CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken
				}
				CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId
			}
		}
	}
}
