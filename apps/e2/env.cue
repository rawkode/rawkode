package cuenv

import (
	"github.com/cuenv/cuenv/schema"
	ciContributors "github.com/cuenv/cuenv/contrib/contributors"
)

schema.#Project

name: "e2"

let _t = tasks

tasks: {
	install: schema.#Task & {
		command: "deno"
		args: ["install", "--frozen"]
		inputs: ["deno.json", "deno.lock", "**/deno.json"]
		hermetic: false
		cache: mode: "never"
	}
	productionPlan: schema.#Task & {
		description: "Inspect production changes without applying them"
		command:     "deno"
		args: ["task", "deploy", "--stage", "production", "--dry-run"]
		// CI selects tasks from changed inputs; uncached does not mean always selected.
		inputs: ["**/*"]
		dependsOn: [install]
		hermetic: false
		cache: mode: "never"
	}
}

ci: {
	providers: ["github"]
	provider: github: permissions: {
		contents:        "read"
		checks:          "none"
		"pull-requests": "none"
	}
	pipelines: productionPlan: {
		environment: "production"
		when: branch: "spike/native-web-rich-editor"
		derivePaths: false
		tasks: [_t.productionPlan]
		provider: github: {
			runner: "ubuntu-latest"
		}
	}
	contributors: [ciContributors.#CuenvRelease, ciContributors.#OnePassword, {
		id: "e2-tools"
		when: always: true
		tasks: [{
			id:       "e2.node"
			label:    "Setup Node"
			priority: 15
			provider: github: {
				uses: "actions/setup-node@v4"
				with: "node-version": "24"
			}
		}, {
			id:       "e2.deno"
			label:    "Setup Deno"
			priority: 15
			provider: github: {
				uses: "denoland/setup-deno@v2"
				with: "deno-version": "2.9.5"
			}
		}]
	}]
}

env: schema.#Env & {
	CLOUDFLARE_ACCOUNT_ID: "0aeb879de8e3cdde5fb3d413025222ce"
	CLOUDFLARE_API_TOKEN: schema.#OnePasswordRef & {
		ref: "op://Employee/Cloudflare/api-tokens/all-access"
	}
	environment: {
		production: {
			WEBSITE_DOMAIN: "apsides.rawkode.academy"
		}
		development: {
			WEBSITE_DOMAIN: "apsides.rawkode.dev"
		}
	}
	GOOGLE_CLIENT_ID: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-google/username"
	}
	GOOGLE_CLIENT_SECRET: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-google/password"
	}
	GITHUB_CLIENT_ID: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-github/username"
	}
	GITHUB_CLIENT_SECRET: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-github/password"
	}
	GITHUB_APP_ID: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-github-app/app-id"
	}
	GITHUB_APP_SLUG: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-github-app/slug"
	}
	GITHUB_APP_PRIVATE_KEY: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-github-app/private-key"
	}
	GITHUB_APP_WEBHOOK_SECRET: schema.#OnePasswordRef & {
		ref: "op://apsides/integration-github-app/webhook-secret"
	}
}
