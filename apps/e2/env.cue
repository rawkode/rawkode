package cuenv

import "github.com/cuenv/cuenv/schema"

name: "e2"

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
		ref: "op://apsides/integrations-google/username"
	}
	GOOGLE_CLIENT_SECRET: schema.#OnePasswordRef & {
		ref: "op://apsides/integrations-google/password"
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
