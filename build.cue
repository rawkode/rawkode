package rawkode

import (
	"dagger.io/dagger"
	"dagger.io/dagger/core"
	"github.com/rawkode/rawkode/projects/web-links:web_links"
)

globalConfig: {
	cloudflare:
		accountId: "340c8fced324c509d19e79ada8f049db"
}

dagger.#Plan & {
	client: filesystem: ".": read: exclude: [
		"**/.git",
		"**/bin",
		"**/node_modules",
	]

	client: env: SOPS_AGE_KEY: dagger.#Secret

	client: commands: sops: {
		name: "sops"
		env: SOPS_AGE_KEY: client.env.SOPS_AGE_KEY
		args: ["-d", "secrets.yaml"]
		stdout: dagger.#Secret
	}

	actions: {
		secrets: core.#DecodeSecret & {
			input:  client.commands.sops.stdout
			format: "yaml"
		}

		projects: {
			webLinks: (web_links & {
				config: {
					cloudflare: {
						accountId: globalConfig.cloudflare.accountId
						apiToken:  secrets.output.cloudflare.apiToken.contents
					}
					pulumi: {
						accessToken: secrets.output.pulumi.accessToken.contents
					}
				}
			}).actions
		}
	}
}
