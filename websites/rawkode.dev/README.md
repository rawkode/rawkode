# rawkode.dev

Astro site for `rawkode.dev`, deployed to Cloudflare Workers with Alteran PDS routes.

## Commands

Run commands from this directory.

| Command | Action |
| :-- | :-- |
| `deno task install` | Install Deno-managed npm dependencies and approve required native package scripts |
| `deno task dev` | Generate Panda CSS and start Astro at `localhost:4321` |
| `deno task build` | Generate assets and build the Worker output in `dist/` |
| `deno task preview` | Preview the production build locally |
| `deno task wrangler -- <args>` | Run Wrangler through Deno |
| `cuenv -e production exec deno task deploy` | Deploy with the production Cloudflare environment |

The Alteran package is published on JSR and declared in `package.json` as a `jsr:` dependency. Deno installs it into `node_modules` so Astro can inject file-backed routes and Wrangler can read the packaged migrations.

## Pull request previews

Every pull request that touches this site gets a [Cloudflare Worker Preview](https://developers.cloudflare.com/workers/previews/) named `pr-<number>`. The URL is posted to the PR by cuenv. The Preview is deleted when the PR closes.

- `.github/workflows/rawkodedev-pullrequest.yml` is generated from the `ci` block in `env.cue`. Regenerate it with `cuenv sync ci -p websites/rawkode.dev`. It runs `previews.migrate` then `previews.deploy`.
- `.github/workflows/rawkodedev-preview-cleanup.yml` is hand-written because cuenv pipelines cannot trigger on a closed PR. It runs `previews.delete`.
- Previews inherit nothing from production. The `previews` block in `wrangler.jsonc` binds D1, R2, and KV to preview-only resources (`rawkode-dev-pds-preview`, `rawkode-dev-session-preview`) shared by all previews. Durable Objects get a fresh namespace per preview. Previews have no secrets, so they cannot sign as `did:web:rawkode.dev`.
- `wrangler.preview-migrations.jsonc` points at the same preview D1 database so Alteran's migrations can be applied before each preview.

Run a preview from your machine with `cuenv -e production task previews.deploy`.
