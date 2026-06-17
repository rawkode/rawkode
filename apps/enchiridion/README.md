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

`env.cue` mirrors the `rawkode.dev` Cloudflare production environment shape. Use `cuenv -e production exec ...` for commands that need the Cloudflare account and API token.

## Pull Request Previews

Opening, reopening, or updating a PR that touches `apps/enchiridion/**` runs `.github/workflows/enchiridion-preview.yml`. The workflow builds Enchiridion, uploads a Cloudflare Worker version with preview alias `pr-<number>`, extracts the `workers.dev` preview URL from Wrangler, and comments that URL back on the PR.

The repository needs these GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

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
