package cuenv

import (
	c "github.com/cuenv/cuenv/contrib/contributors"
	"github.com/cuenv/cuenv/schema"
)

schema.#Project & {
	name: "rawkode.dev"
}

// Keep both site workflows on the cuenv release already used by this project.
config: ci: cuenv: version: "0.55.1"

let _t = tasks

env: {
	environment: production: {
		CLOUDFLARE_ACCOUNT_ID: "0aeb879de8e3cdde5fb3d413025222ce"
		CLOUDFLARE_API_TOKEN:  schema.#OnePasswordRef & {ref: "op://sa.rawkode.academy/cloudflare/api-tokens/workers"}
	}
}

// `cuenv ci` starts tasks with a cleared environment. Forward the runner's
// PATH so they can find deno, which the Deno contributor installs (there is
// no Nix runtime here to provide it).
_hostPath: PATH: schema.#EnvPassthrough & {cuenvPassthrough: true}

_previewInputs: [
	"astro.config.mjs",
	"deno.json",
	"deno.lock",
	"env.cue",
	"public/**/*",
	"scripts/**/*",
	"src/**/*",
	"wrangler.jsonc",
	"wrangler.preview-migrations.jsonc",
]

tasks: {
	install: schema.#Task & {
		description: "Install Deno-managed npm dependencies"
		env:         _hostPath
		command:     "deno"
		args: ["task", "install"]
		hermetic: false
		inputs: ["deno.json", "deno.lock", "package.json"]
		outputs: ["node_modules"]
	}

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
		env:         _hostPath
		command:     "deno"
		args: ["task", "build"]
		dependsOn: [_t.install]
		hermetic: false
		inputs: [
			"astro.config.mjs",
			"deno.json",
			"deno.lock",
			"panda.config.ts",
			"postcss.config.cjs",
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
		env:         _hostPath
		command:     "deno"
		args: ["task", "deploy"]
		hermetic: false
		dependsOn: [_t.build]
		inputs: [
			"astro.config.mjs",
			"deno.json",
			"deno.lock",
			"env.cue",
			"package.json",
			"panda.config.ts",
			"postcss.config.cjs",
			"public/**/*",
			"scripts/**/*",
			"src/**/*",
			"styled-system/**/*",
			"wrangler.jsonc",
		]
	}

	// Cloudflare Worker Previews, one per pull request.
	// https://developers.cloudflare.com/workers/previews/
	previews: schema.#TaskGroup & {
		type: "group"

		migrate: schema.#Task & {
			description: "Apply Alteran D1 migrations to the shared preview database"
			env:         _hostPath
			command:     "deno"
			args: ["task", "wrangler", "d1", "migrations", "apply", "ALTERAN_DB", "--remote", "--config", "wrangler.preview-migrations.jsonc"]
			dependsOn: [_t.install]
			hermetic: false
			inputs: _previewInputs
		}

		deploy: schema.#Task & {
			description: "Create or update the Worker Preview for this pull request"
			env: _hostPath & {GITHUB_REF_NAME: schema.#EnvPassthrough & {cuenvPassthrough: true}}
			// A script file, not an inline `script:`: cuenv ci mangles multi-line
			// inline shell. It names the preview pr-<number> from GITHUB_REF_NAME.
			command: "sh"
			args: ["scripts/preview.sh", "deploy"]
			dependsOn: [_t.build, _t.previews.migrate]
			hermetic: false
			inputs: _previewInputs
			captures: previewUrl: {
				// `wrangler preview --json` reports `preview_urls` (or `preview.urls`).
				pattern: #"(?:preview_)?urls"\s*:\s*\[\s*"(https://[^"]+)""#
			}
		}

		delete: schema.#Task & {
			description: "Delete the Worker Preview for a closed pull request"
			env: _hostPath & {GITHUB_REF_NAME: schema.#EnvPassthrough & {cuenvPassthrough: true}}
			command: "sh"
			args: ["scripts/preview.sh", "delete"]
			dependsOn: [_t.install]
			hermetic: false
		}
	}
}

// cuenv ships no Deno contributor; install it with the official action.
_deno: schema.#Contributor & {
	id: "deno"
	when: always: true
	tasks: [{
		id:       "deno.setup"
		label:    "Setup Deno"
		priority: 20
		script:   "curl -fsSL https://deno.land/install.sh | sh -s -- --yes && echo \"$HOME/.deno/bin\" >> \"$GITHUB_PATH\""
		provider: github: {
			uses: "denoland/setup-deno@v2"
			with: {
				"deno-version": "v2.x"
				cache: true
			}
		}
	}]
}

ci: {
	providers: ["github"]
	contributors: [
		c.#CuenvRelease,
		c.#OnePassword,
		_deno,
	]
	provider: github: permissions: {
		contents:        "read"
		checks:          "write"
		"pull-requests": "write"
	}
	pipelines: {
		default: {
			environment: "production"
			when: {
				branch: ["main"]
				defaultBranch: true
				manual: true
			}
			tasks: [_t.deploy]
		}
		pullRequest: {
			environment: "production"
			when: pullRequest: true
			tasks: [_t.previews.deploy]
			annotations: "Preview URL": schema.#TaskCaptureRef & {
				cuenvTask:    "previews.deploy"
				cuenvCapture: "previewUrl"
			}
		}
	}
}
