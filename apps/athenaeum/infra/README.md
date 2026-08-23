# Athenaeum infra (Alchemy)

Deploy-time IaC for Athenaeum, built on [Alchemy](https://alchemy.run) `2.0.0-beta.74`
(pinned exact — it's a beta; bump deliberately, not via `^`).

**Scope: exactly one resource** — the Cloudflare AI Gateway that
`packages/backend/src/ai-gateway-route.ts` routes all three inference clients through
(Anthropic Messages, OpenAI transcription, OpenAI Realtime voice — see
`docs/ai-gateway-decisions.md`). The `wrangler.jsonc` files in `packages/*` remain the
operative configs for local dev and Worker deploys; this package is the deploy-time layer that
provisions the gateway they point at, not a replacement for them.

## Why this package has its own `effect` version

Alchemy 2.x is Effect-native and requires `effect >=4.0.0-rc.110` (a *required* peer — every
other alchemy peer is optional). The rest of this workspace is on the catalog's
`effect@3.22.1` (effect 4 is still an RC; 3.22.1 is npm `latest`). The two majors cannot
coexist in one program, so `infra/` is its own workspace package (listed separately in
`pnpm-workspace.yaml`, not under `packages/*`) with `effect@4.0.0-rc.111` pinned exactly,
and it deliberately does not use the workspace's `effect` catalog entry. pnpm isolates the
two versions per-package; nothing in `packages/*` sees effect 4 and nothing here sees
effect 3. `@effect/platform-node@4.0.0-rc.111` is also a direct dependency: the alchemy CLI
needs it to run on Node (it's an optional peer only because bun users get
`@effect/platform-bun` instead).

## What's declared

`alchemy.run.ts` (the alchemy CLI's default entrypoint name — `alchemy deploy [<main>]`
defaults to it) defines one stack, `Athenaeum`, containing one `Cloudflare.AI.Gateway`:

| setting | value | why |
|---|---|---|
| `id` | `athenaeum` | The `{gateway_id}` URL segment == `CF_AI_GATEWAY_NAME`. Fixed rather than the default `${app}-${stage}-${id}` so the backend's config never changes across redeploys. Consequence: all stages share this one gateway id — deploy it from one stage only (see below). |
| `collectLogs` | `true` | Observability is the reason the gateway exists. |
| `cacheTtl` | `300` | Modest: identical repeated requests served from cache for 5 min. Cheap insurance against retry loops / double submits; Realtime WS is uncacheable anyway. |
| `authentication` | `false` | Authenticated Gateway off, matching the routing pass's default (`CF_AI_GATEWAY_TOKEN` optional). Provider keys are pass-through, so a discovered gateway URL is useless without David's own provider secrets; the token would guard only log noise. |

Stack outputs map 1:1 onto the backend's env contract:

| stack output | backend env var |
|---|---|
| `accountId` | `CF_AI_GATEWAY_ACCOUNT_ID` |
| `gatewayName` | `CF_AI_GATEWAY_NAME` |

`CF_AI_GATEWAY_TOKEN` is intentionally not produced: with `authentication: false` there is no
token. If you flip `authentication: true`, mint a gateway-scoped **Run token** in the
dashboard (AI → AI Gateway → your gateway → Authentication) and
`wrangler secret put CF_AI_GATEWAY_TOKEN` on the backend Worker — Alchemy toggles the
setting but does not mint or output the token.

## What David runs

All commands from this directory (`apps/athenaeum/infra/`); `pnpm exec` uses the
locally-pinned CLI.

### 1. One-time auth

```sh
pnpm exec alchemy login
```

Interactive: pick Cloudflare, then OAuth (opens a browser) or paste an API token.
Credentials land in `~/.alchemy/profiles.json` under the `default` profile (`--profile` to
use another). No wrangler login and no `CLOUDFLARE_API_TOKEN` env var needed — though CI-style
env-var credentials work with `CI=1` set.

### 2. Preview, then deploy

```sh
pnpm exec alchemy plan --stage prod      # dry run: shows what would be created/changed
pnpm exec alchemy deploy --stage prod    # provisions the gateway, prints stack outputs
```

`--stage` defaults to `dev_${USER}`; since the gateway `id` is fixed (see above), pick one
stage — `prod` — and always use it, so two stages never fight over the same gateway id.
`alchemy deploy --dry-run` is equivalent to `plan`. `alchemy destroy --stage prod` tears the
gateway down.

State: the stack uses `Cloudflare.state()` — stack state lives in your own Cloudflare
account (first deploy bootstraps a small `alchemy-state-store` Worker there), so state
survives machine changes and is CI-reachable. Swap to `Alchemy.localState()` in
`alchemy.run.ts` for purely-local `.alchemy/` state if you'd rather not have that Worker.

Reading outputs later without redeploying:

```sh
pnpm exec alchemy state get --stack Athenaeum --stage prod --fqn Gateway
pnpm exec alchemy state export --stack Athenaeum --stage prod
```

### 3. Wire the outputs into the backend

Per `packages/backend/wrangler.jsonc`'s AI Gateway comment block: set the two outputs as
plain `vars` (they're not sensitive) on the real backend deployment —

```jsonc
"vars": {
  "CF_AI_GATEWAY_ACCOUNT_ID": "<accountId output>",
  "CF_AI_GATEWAY_NAME": "athenaeum"
}
```

— and set neither to stay in DIRECT mode (setting exactly one is a loud
misconfiguration error at DO construction, by design). Provider keys
(`ANTHROPIC_API_KEY`, `OPENAI_*`) are unchanged in both modes: pass-through, not BYOK.

### Behavior without credentials (verified)

Running `alchemy plan`/`deploy` with no profile configured fails fast and clean —
non-interactively it exits 1 with
`AuthError: No credentials configured for 'Cloudflare' in profile 'default' … Run 'alchemy login --profile default'`;
in a TTY it offers the interactive login instead. Nothing hangs, nothing is fabricated.

## Deliberately NOT declared here (future work)

The backend/router/gatekeeper Workers, the `athenaeum-meeting-audio` R2 bucket, and the DO
migrations stay in their `wrangler.jsonc` files. Alchemy 2.x's Worker resource expects
Workers *authored as* Effect-native `Cloudflare.Worker(...)` modules with bindings declared
in Alchemy code — Athenaeum's Workers are plain wrangler Workers using `worker_loaders` (no
Alchemy equivalent found in the current docs), ctx.exports-based DO classes with sqlite
migration tags, `run_worker_first` assets, and service bindings. Declaring them in Alchemy
would be a rewrite of the Workers themselves, not a transcription of the wrangler configs —
out of scope until either Alchemy grows a "deploy an existing wrangler project" mode or the
Workers are intentionally rewritten Effect-native.
