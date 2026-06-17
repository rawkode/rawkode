package cuenv

import (
	contrib "github.com/cuenv/cuenv/contrib/contributors"
	"github.com/cuenv/cuenv/schema"
)

schema.#Project

name: "enchiridion"
runtime: schema.#NixRuntime & {
	flake: "."
}

let _t = tasks

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
		hermetic: false
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
		hermetic: false
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
		hermetic: false
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

	deploy: schema.#TaskGroup & {
		type: "group"
		main: schema.#Task & {
			description: "Apply production D1 migrations and deploy Enchiridion"
			command:     "npm"
			args: ["run", "deploy"]
			hermetic: false
			inputs: [
				"astro.config.mjs",
				"env.cue",
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
		}
		preview: schema.#Task & {
			description: "Upload a Cloudflare Worker preview version"
			command:     "npm"
			args: ["run", "preview:upload"]
			dependsOn: [_t.build]
			hermetic: false
			inputs: [
				"astro.config.mjs",
				"env.cue",
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
			captures: previewUrl: {
				pattern: "Version Preview URL: (.+)"
			}
		}
	}
}

ci: {
	providers: ["github"]
	contributors: [contrib.#Nix, contrib.#Cuenv, contrib.#OnePassword]
	provider: github: permissions: {
		contents:      "read"
		"pull-requests": "write"
	}
	pipelines: {
		default: {
			environment: "production"
			when: {
				branch: ["main"]
				defaultBranch: true
				manual:        true
			}
			tasks: [_t.deploy.main]
		}
		pullRequest: {
			environment: "production"
			when: pullRequest: true
			tasks: [_t.check, _t.deploy.preview]
			annotations: "Preview URL": schema.#TaskCaptureRef & {
				cuenvTask:    "deploy.preview"
				cuenvCapture: "previewUrl"
			}
		}
	}
}
