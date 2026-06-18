package cuenv

import (
	c "github.com/cuenv/cuenv/contrib/contributors"
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
		ENCHIRIDION_PASSWORD:  schema.#OnePasswordRef & {ref: "op://sa.rawkode.academy/cloudflare/api-tokens/enchiridion"}
		// sync-worker-secrets uploads derived host-context HMAC material from this explicit seed.
		HOST_SIGNING_SECRET:  schema.#OnePasswordRef & {ref: "op://sa.rawkode.academy/cloudflare/api-tokens/enchiridion"}
	}
}

tasks: {
	install: schema.#Task & {
		description: "Install Bun dependencies from the lockfile"
		command:     "bun"
		args: ["install", "--frozen-lockfile"]
		hermetic: false
		inputs: [
			"bun.lock",
			"package.json",
		]
		outputs: ["node_modules"]
	}

	dev: schema.#Task & {
		description: "Start the Flue Cloudflare worker dev server"
		command:     "bun"
		args: ["run", "dev"]
		hermetic: false
	}

	devUI: schema.#Task & {
		description: "Start the local Astro asset proxy for the app shell"
		command:     "bun"
		args: ["run", "dev:ui"]
		hermetic: false
	}

	check: schema.#Task & {
		description: "Run TypeScript, Vitest, and Astro diagnostics"
		command:     "bun"
		args: ["run", "check"]
		dependsOn: [_t.install]
		hermetic: false
		inputs: [
			"astro.config.mjs",
			"bun.lock",
			"flue.config.ts",
			"package.json",
			"scripts/**/*",
			"src/**/*",
			"tests/**/*",
			"tsconfig.json",
		]
	}

	build: schema.#Task & {
		description: "Build the Cloudflare worker and Astro app shell"
		command:     "bun"
		args: ["run", "build"]
		dependsOn: [_t.install]
		hermetic: false
		inputs: [
			"astro.config.mjs",
			"bun.lock",
			"flue.config.ts",
			"migrations/**/*",
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
		command:     "bun"
		args: ["run", "preview"]
		dependsOn: [build]
		hermetic: false
	}

	deploy: schema.#TaskGroup & {
		type: "group"
		main: schema.#Task & {
			description: "Apply production D1 migrations and deploy Enchiridion"
			command:     "bun"
			args: ["run", "deploy"]
			dependsOn: [_t.install]
			hermetic: false
			inputs: [
				"astro.config.mjs",
				"bun.lock",
				"env.cue",
				"flue.config.ts",
				"migrations/**/*",
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
			command:     "bun"
			args: ["run", "preview:upload"]
			dependsOn: [_t.build]
			hermetic: false
			inputs: [
				"astro.config.mjs",
				"bun.lock",
				"env.cue",
				"flue.config.ts",
				"migrations/**/*",
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
	contributors: [
		c.#Nix,
		c.#BunWorkspace,
		c.#CuenvRelease,
		c.#OnePassword,
	]
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
