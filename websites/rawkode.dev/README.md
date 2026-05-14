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
