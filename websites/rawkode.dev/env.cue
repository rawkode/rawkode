package cuenv

import (
	c "github.com/cuenv/cuenv/contrib/contributors"
	"github.com/cuenv/cuenv/schema"
)

schema.#Project & {
	name: "rawkode.dev"
}

let _t = tasks

env: {
	environment: production: {
		CLOUDFLARE_ACCOUNT_ID: "0aeb879de8e3cdde5fb3d413025222ce"
		CLOUDFLARE_API_TOKEN:  schema.#OnePasswordRef & {ref: "op://sa.rawkode.academy/cloudflare/api-tokens/workers"}
	}
}

// Preview name for the current pull request: GITHUB_REF_NAME is "<number>/merge"
// on pull_request events. Outside a PR, fall back to wrangler's default (the
// current git branch).
_previewName: """
	case "${GITHUB_REF_NAME:-}" in
	  */merge) preview_name="pr-${GITHUB_REF_NAME%%/*}" ;;
	  *) preview_name="" ;;
	esac
	"""

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
			script: _previewName + "\n" + """
				deno task wrangler preview ${preview_name:+--name "$preview_name"} --json
				"""
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
			script: _previewName + "\n" + """
				deno task wrangler preview delete ${preview_name:+--name "$preview_name"} --skip-confirmation
				"""
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
			with: "deno-version": "v2.x"
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
