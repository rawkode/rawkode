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

Production deploys use `op://sa.rawkode.academy/cloudflare/api-tokens/workers` as Wrangler's `CLOUDFLARE_API_TOKEN`. The deployed Worker also receives that token for dynamic mini-app uploads.

Worker runtime secrets are synced during production deploy with `npm run sync:secrets`. `ENCHIRIDION_PASSWORD` comes from `op://sa.rawkode.academy/cloudflare/api-tokens/enchiridion`. `HOST_SIGNING_SECRET` is a domain-separated hash derived from the same 1Password-backed Enchiridion secret unless an explicit `HOST_SIGNING_SECRET` is provided in the cuenv environment.

## Auth

Production requests must be authenticated. Enchiridion accepts either Cloudflare Access headers or HTTP Basic auth. The Basic auth password is loaded from `op://sa.rawkode.academy/cloudflare/api-tokens/enchiridion` and synced into the Worker as `ENCHIRIDION_PASSWORD`.

Cloudflare Access mode accepts the `cf-access-authenticated-user-email` and `cf-access-authenticated-user-name` headers and can restrict accepted identities with `ALLOWED_EMAILS`.

The dev identity fallback is local-only. Requests to `localhost`, `127.0.0.1`, or `[::1]` use `DEV_USER_EMAIL` when set, otherwise `rawkode.local`. The fallback is ignored on deployed hosts.

Host-context signing also has a local-only fallback. Production dispatch and host-context token issuance require `HOST_SIGNING_SECRET`; missing production signing material returns a server error instead of using a hardcoded secret.

## Pull Request Previews

Opening, reopening, or updating a PR that touches `apps/enchiridion/**` runs the cuenv-generated `.github/workflows/enchiridion-pullrequest.yml` workflow. The workflow runs `cuenv ci --pipeline pullRequest --path apps/enchiridion`; `env.cue` defines the check and preview upload tasks, and the `deploy.preview` task captures Wrangler's `Version Preview URL`.

Cloudflare credentials are not duplicated into GitHub repository secrets. They are declared as 1Password references in `env.cue`, and the generated cuenv workflow resolves them through the same provider flow used by the other rawkode projects.

D1 migrations are applied only on the production deploy path. PR previews upload a Worker preview version and do not mutate the production database schema.

## Cloudflare Resources

- D1 database: `enchiridion` (`0b7c04ac-8fdc-4941-a9cf-36757c24efa7`)
- Workers for Platforms dispatch namespace: `enchiridion-mini-apps`
- Dynamic Worker loader binding: `LOADER`

## Architecture

- Astro renders the static app shell and React/Tiptap islands.
- `src/app.ts` owns API routes, auth, Flue mounting, and `/apps/:slug/*` dispatch.
- D1 stores daily notes, extension manifests, resource index records, audit logs, and demo app data.
- Flue owns the in-app agent, the durable `mini-app-builder` agent, and bounded host workflows.
- Workers for Platforms dispatches autonomous mini-app Workers.
- Dynamic Workers custom bindings are the target primitive for stateful mini apps. The host should expose scoped RPC stubs for D1/KV/R2/AI and app capabilities rather than passing raw resource bindings to generated code.

## Mini-App Builds

Mini-app requests are admitted through `POST /api/mini-app-builds`. The route creates a D1 build ledger row, dispatches the durable Flue `mini-app-builder` agent with that build id, stores the returned submission id, and returns immediately. The browser only embeds the request block and polls the build row, so closing or reloading the tab does not own the work.

Builds have a 30 minute deadline. The builder agent must call its scoped `submit_mini_app_candidate` tool to validate the manifest, upload the Workers for Platforms dispatch Worker, smoke test routes, save the extension, and settle the build. Scheduled mini-app behavior is declared as manifest workflows; the Enchiridion host scheduler owns cron and calls app-owned workflow routes under `/apps/:slug/*`.

Stateful mini apps are first-class platform work, not a fallback path. A generated app may declare D1/KV/R2/AI-style binding needs and scheduled workflows, but autonomous activation stops at `requires_binding_provisioning` until Enchiridion provisions scoped Dynamic Worker custom bindings and records app-owned migrations. The next platform slice is a capability broker that wraps host resources as narrow WorkerEntrypoint stubs, passes those stubs through `LOADER.load({ env })`, and exposes TypeScript capability declarations to the builder agent.

Mini apps should get real D1, R2, KV, AI, scheduled workflow, and future connector access through those scoped stubs. They should not receive raw host bindings or account-wide credentials. Each capability must be declared in the manifest, resolved by the host, passed to the Dynamic Worker explicitly, and audited when used.

## First Slice

- Daily notes with autosaved Tiptap JSON.
- Extension manifest registry.
- CmdK-style command palette.
- Tiptap extension blocks.
- Bookmarks and Projects/Kanban demo mini apps.
