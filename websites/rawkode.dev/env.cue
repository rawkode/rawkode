package cuenv

import (
	"github.com/cuenv/cuenv/schema"
)

schema.#Project & {
	name: "rawkode.dev"
}

env: {
	environment: production: {
		CLOUDFLARE_ACCOUNT_ID: "0aeb879de8e3cdde5fb3d413025222ce"
		CLOUDFLARE_API_TOKEN:  schema.#OnePasswordRef & {ref: "op://sa.rawkode.academy/cloudflare/api-tokens/workers"}
	}
}

tasks: {
	codegen: schema.#Task & {
		description: "Generate Panda CSS styled-system"
		command:     "deno"
		args: ["task", "codegen"]
		inputs: ["panda.config.ts", "postcss.config.cjs", "src/**/*"]
		outputs: ["styled-system/**/*"]
	}

	dev: schema.#Task & {
		description: "Start the Astro dev server"
		command:     "deno"
		args: ["task", "dev"]
		hermetic: false
	}

	build: schema.#Task & {
		description: "Build the production site"
		command:     "deno"
		args: ["task", "build"]
		inputs: [
			"astro.config.mjs",
			"deno.json",
			"deno.lock",
			"public/**/*",
			"scripts/**/*",
			"src/**/*",
			"styled-system/**/*",
		]
		outputs: ["dist/**/*"]
	}

	preview: schema.#Task & {
		description: "Preview the production build locally"
		command:     "deno"
		args: ["task", "preview"]
		dependsOn: [build]
		hermetic: false
	}

	deploy: schema.#Task & {
		description: "Deploy to Cloudflare Workers"
		command:     "deno"
		args: ["task", "deploy"]
		hermetic: false
	}
}
