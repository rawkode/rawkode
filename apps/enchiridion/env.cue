package cuenv

import (
	"github.com/cuenv/cuenv/schema"
)

schema.#Project & {
	name: "enchiridion"
}

env: {
	environment: production: {
		CLOUDFLARE_ACCOUNT_ID: "0aeb879de8e3cdde5fb3d413025222ce"
		CLOUDFLARE_API_TOKEN:  schema.#OnePasswordRef & {ref: "op://sa.rawkode.academy/cloudflare/api-tokens/workers"}
	}
}

tasks: {
	install: schema.#Task & {
		description: "Install npm dependencies from the lockfile"
		command:     "npm"
		args: ["ci"]
		outputs: ["node_modules/**/*"]
	}

	dev: schema.#Task & {
		description: "Start the Flue Cloudflare worker dev server"
		command:     "npm"
		args: ["run", "dev"]
		hermetic: false
	}

	devUI: schema.#Task & {
		description: "Start the local Astro asset proxy for the app shell"
		command:     "npm"
		args: ["run", "dev:ui"]
		hermetic: false
	}

	check: schema.#Task & {
		description: "Run TypeScript, Vitest, and Astro diagnostics"
		command:     "npm"
		args: ["run", "check"]
		inputs: [
			"astro.config.mjs",
			"flue.config.ts",
			"package-lock.json",
			"package.json",
			"src/**/*",
			"tests/**/*",
			"tsconfig.json",
		]
	}

	build: schema.#Task & {
		description: "Build the Cloudflare worker and Astro app shell"
		command:     "npm"
		args: ["run", "build"]
		inputs: [
			"astro.config.mjs",
			"flue.config.ts",
			"migrations/**/*",
			"package-lock.json",
			"package.json",
			"public/**/*",
			"scripts/**/*",
			"src/**/*",
			"tsconfig.json",
			"wrangler.jsonc",
		]
		outputs: ["dist/**/*"]
	}

	preview: schema.#Task & {
		description: "Preview the built Worker and app shell locally"
		command:     "npm"
		args: ["run", "preview"]
		dependsOn: [build]
		hermetic: false
	}

	deployPreview: schema.#Task & {
		description: "Upload a Cloudflare Worker preview version"
		command:     "npm"
		args: ["run", "preview:upload", "--"]
		dependsOn: [build]
		hermetic: false
	}

	deploy: schema.#Task & {
		description: "Deploy Enchiridion to Cloudflare Workers"
		command:     "npm"
		args: ["run", "deploy"]
		hermetic: false
	}
}
