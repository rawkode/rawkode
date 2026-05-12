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
		command:     "bun"
		args: ["run", "panda", "codegen", "--silent"]
		inputs: ["panda.config.ts", "postcss.config.cjs", "src/**/*"]
		outputs: ["styled-system/**/*"]
	}

	dev: schema.#Task & {
		description: "Start the Astro dev server"
		command:     "bun"
		args: ["run", "dev"]
		dependsOn: [codegen]
		hermetic: false
	}

	build: schema.#Task & {
		description: "Build the production site"
		command:     "bun"
		args: ["run", "build"]
		dependsOn: [codegen]
		inputs: [
			"astro.config.mjs",
			"package.json",
			"bun.lock",
			"public/**/*",
			"scripts/**/*",
			"src/**/*",
			"styled-system/**/*",
		]
		outputs: ["dist/**/*"]
	}

	preview: schema.#Task & {
		description: "Preview the production build locally"
		command:     "bun"
		args: ["run", "preview"]
		dependsOn: [build]
		hermetic: false
	}

	deploy: schema.#Task & {
		description: "Deploy to Cloudflare Workers"
		command:     "bunx"
		args: ["wrangler", "deploy"]
		dependsOn: [build]
		hermetic: false
	}
}
