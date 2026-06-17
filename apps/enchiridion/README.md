# Enchiridion

Private second brain on Cloudflare, Astro, Flue, D1, and Workers for Platforms.

## Development

```sh
npm install
npm run dev
```

The app builds in two stages:

- `npm run build:client` builds the Astro app shell to `dist/client`.
- `npm run build:worker` builds the Flue/Hono Cloudflare Worker.
- `npm run preview` serves the built Worker and app shell locally through Wrangler.
- `npm run deploy:preview -- --preview-alias pr-123` uploads a Cloudflare Worker preview version.
- `npm run deploy` builds the app, applies production D1 migrations, and deploys the Worker.

`env.cue` mirrors the rawkode cuenv Cloudflare production environment shape. Use `cuenv exec -e production -- ...` for commands that need the Cloudflare account and API token.

## Pull Request Previews

Opening, reopening, or updating a PR that touches `apps/enchiridion/**` runs the cuenv-generated `.github/workflows/enchiridion-pullrequest.yml` workflow. The workflow runs `cuenv ci --pipeline pullRequest --path apps/enchiridion`; `env.cue` defines the check and preview upload tasks, and the `deploy.preview` task captures Wrangler's `Version Preview URL`.

Cloudflare credentials are not duplicated into GitHub repository secrets. They are declared as 1Password references in `env.cue`, and the generated cuenv workflow resolves them through the same provider flow used by the other rawkode projects.

D1 migrations are applied only on the production deploy path. PR previews upload a Worker preview version and do not mutate the production database schema.

## Cloudflare Resources

- D1 database: `enchiridion` (`0b7c04ac-8fdc-4941-a9cf-36757c24efa7`)

## Architecture

- Astro renders the static app shell and React/Tiptap islands.
- `src/app.ts` owns API routes, auth, Flue mounting, and `/apps/:slug/*` dispatch.
- D1 stores daily notes, extension manifests, resource index records, audit logs, and demo app data.
- Flue owns the in-app agent and bounded workflows such as mini-app generation.
- Workers for Platforms dispatches autonomous mini-app Workers.

## First Slice

- Daily notes with autosaved Tiptap JSON.
- Extension manifest registry.
- CmdK-style command palette.
- Tiptap extension blocks.
- Bookmarks and Projects/Kanban demo mini apps.
