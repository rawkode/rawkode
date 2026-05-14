---
title: "Introducing Alteran: an atproto PDS on Cloudflare via Astro"
description: "Alteran turns an Astro site on Cloudflare Workers into a single-user atproto PDS backed by D1, R2, and Durable Objects."
pubDate: 2026-05-12
tags: ["atproto", "astro", "cloudflare"]
---

<div style="text-align: center; margin: var(--space-4) 0 var(--space-12); padding: var(--space-2) 0;">
  <a href="https://github.com/alteran-social/alteran" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; gap: 0.7em; padding: 0.85em 1.6em; background: #24292f; color: #ffffff; font-family: var(--fonts-sans); font-size: 0.95rem; font-weight: 600; letter-spacing: 0.02em; text-transform: none; text-decoration: none; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; background-image: none; padding-bottom: 0.85em; box-shadow: 0 1px 0 rgba(27, 31, 36, 0.04), 0 1px 3px rgba(27, 31, 36, 0.12);">
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="flex-shrink: 0;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>
    <span>Just show me the code</span>
  </a>
</div>

Alteran is an Astro integration that turns a Cloudflare Workers-deployed Astro site into a single-user atproto PDS. It adds identity documents, XRPC routes, D1-backed repository and account state, R2 blob storage, and a Durable Object sequencer to the same Worker that serves the site.

I built Alteran because I wanted my website to host my atproto PDS, with the PDS signing material in my own Cloudflare deployment instead of on Bluesky's hosted PDS.

I also wanted it on Cloudflare. I spend enough time dealing with servers and containers at work; for my own website, I want the operational model to be a Worker, D1, R2, and a Durable Object.

`rawkode.dev` is already an Astro site deployed to Cloudflare Workers. With Alteran, the same Worker serves the website, atproto identity documents, and the XRPC routes used by a single-user PDS.

The first public package shipped as `0.5.2`; the setup below uses `0.8.5` from JSR. Alteran is early and single-user. This article introduces the project and documents the setup I am using for `rawkode.dev`.

These examples target `@alteran-social/alteran@0.8.5` from JSR, which expects Cloudflare bindings named `ALTERAN_DB`, `ALTERAN_BLOBS`, and `ALTERAN_SEQUENCER`, and Wrangler applies the SQL migrations published inside the JSR package.

## Prerequisites

This article assumes:

- an Astro site that can run on Cloudflare Workers, not a static-only deployment
- a domain you control and want to use as the atproto handle
- Wrangler authenticated against the target Cloudflare account
- Deno for the commands shown here
- Cloudflare D1, R2, and Durable Objects available on the account
- separate D1, R2, and Durable Object resources for Alteran state
- a new single-user `did:web` PDS target for the commands below, or a separate migration plan for an existing DID

This article covers a new `did:web` setup for `rawkode.dev`, not an existing-account migration. With `did:web`, the DID is tied to the domain. If I lose control of `rawkode.dev`, I lose control of `did:web:rawkode.dev`.

Migrating an existing account is a separate flow.

## What Alteran Adds

An atproto PDS needs identity endpoints, XRPC routes, storage for records and blobs, session handling, and a stream of repository events.

Alteran maps those pieces onto Cloudflare primitives:

- Astro routes for `/.well-known/*`, `/health`, `/ready`, and `/xrpc/*`
- a dedicated D1 database for account, record, token, and repository metadata
- a dedicated R2 bucket for blob storage
- a dedicated Durable Object binding for repository event sequencing
- Wrangler secrets and vars for identity, auth, and signing material

Alteran does not replace the website. It injects PDS routes into the Astro app. I keep my homepage and blog routes as normal Astro pages, and let Alteran own the atproto routes.

Alteran state should be isolated from the rest of the site. I do not want my website database and my PDS database sharing schema ownership, migration history, backup policy, or restore semantics.

## Install Alteran

Install Alteran through `package.json` as a JSR dependency:

```json
{
  "type": "module",
  "dependencies": {
    "@alteran-social/alteran": "jsr:@alteran-social/alteran@0.8.5"
  }
}
```

Keep the Deno task and tool dependencies in `deno.json`, then run:

```sh
deno install
```

Deno can import JSR modules directly, but this Astro integration currently injects file-backed route entrypoints and Wrangler needs a real migrations directory. Declaring Alteran in `package.json` as a `jsr:` dependency makes Deno install it into `node_modules` while still keeping JSR as the source. Alteran's package API, route list, migrations, bindings, and protocol coverage are still changing.

## Set the Identity

For `rawkode.dev`, the identity vars are:

```txt
PDS_DID=did:web:rawkode.dev
PDS_HANDLE=rawkode.dev
PDS_HOSTNAME=rawkode.dev
```

Alteran serves two identity files:

- `/.well-known/atproto-did` returns `did:web:rawkode.dev`
- `/.well-known/did.json` returns the DID document, including the `did:web:rawkode.dev#atproto_pds` service endpoint

That gives atproto clients the handle-to-DID link and the DID-to-PDS link. If these files are wrong, clients will not resolve the PDS correctly.

## Create Isolated Storage

Create the D1 database and R2 bucket before writing the Wrangler config:

```sh
deno task wrangler d1 create rawkode-dev-pds
deno task wrangler r2 bucket create rawkode-dev-pds
```

Put the generated D1 database ID into `wrangler.jsonc`.

Wrangler needs a migrations directory for each D1 binding. Alteran `0.8.5` publishes its migrations in the package, so point Wrangler at that directory:

```jsonc
{
  "d1_databases": [
    {
      "binding": "ALTERAN_DB",
      "database_name": "rawkode-dev-pds",
      "database_id": "<cloudflare-d1-database-id>",
      "migrations_dir": "./node_modules/@alteran-social/alteran/migrations"
    }
  ]
}
```

These commands use Deno with `nodeModulesDir: "auto"`, so `./node_modules/@alteran-social/alteran/migrations` is the path Wrangler applies.

Then apply the schema to the remote D1 database:

```sh
deno task wrangler d1 migrations apply rawkode-dev-pds --remote
```

## Configure Astro

The site must run as a Cloudflare Worker. My Astro config is:

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import alteran from '@alteran-social/alteran';

export default defineConfig({
  site: 'https://rawkode.dev',
  adapter: cloudflare({ mode: 'advanced', imageService: 'compile' }),
  integrations: [
    alteran({
      debugRoutes: false,
      includeRootEndpoint: false,
    }),
  ],
});
```

`includeRootEndpoint: false` keeps `/` mapped to the Astro homepage instead of Alteran's root endpoint.

`debugRoutes: false` disables the injected Astro debug routes. In `0.8.5`, the Worker runtime still exposes its own sequencer debug route.

In `0.8.5`, Alteran reads Cloudflare bindings named `ALTERAN_DB`, `ALTERAN_BLOBS`, and `ALTERAN_SEQUENCER`. The resources behind those bindings should be dedicated to Alteran.

## Configure Wrangler

My Wrangler config has the same Worker serving the site and the PDS. The Alteran resources use `ALTERAN_*` bindings so they do not collide with bindings owned by the site:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "rawkode-dev",
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2025-09-27",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS"
  },
  "build": {
    "command": "deno task build",
    "cwd": "."
  },
  "routes": [
    {
      "custom_domain": true,
      "pattern": "rawkode.dev"
    }
  ],
  "vars": {
    "PDS_DID": "did:web:rawkode.dev",
    "PDS_HANDLE": "rawkode.dev",
    "PDS_HOSTNAME": "rawkode.dev",
    "PDS_EMAIL": "david@rawkode.dev",
    "PDS_CONTACT_EMAIL": "david@rawkode.dev"
  },
  "d1_databases": [
    {
      "binding": "ALTERAN_DB",
      "database_name": "rawkode-dev-pds",
      "database_id": "<cloudflare-d1-database-id>",
      "migrations_dir": "./node_modules/@alteran-social/alteran/migrations"
    }
  ],
  "r2_buckets": [
    {
      "binding": "ALTERAN_BLOBS",
      "bucket_name": "rawkode-dev-pds"
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "ALTERAN_SEQUENCER", "class_name": "Sequencer" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["Sequencer"] }
  ]
}
```

The public identity values can live in `vars`. Passwords and signing material should be Wrangler secrets.

If the host site also uses D1, do not put the site tables and PDS tables in the same database. Keep the site database and the Alteran database as separate D1 bindings:

```jsonc
{
  "d1_databases": [
    {
      "binding": "SITE_DB",
      "database_name": "rawkode-dev-site",
      "database_id": "<site-database-id>",
      "migrations_dir": "migrations/site"
    },
    {
      "binding": "ALTERAN_DB",
      "database_name": "rawkode-dev-pds",
      "database_id": "<pds-database-id>",
      "migrations_dir": "./node_modules/@alteran-social/alteran/migrations"
    }
  ]
}
```

That separation matters when you back up, restore, inspect, or apply migrations.

The middleware currently returns `Access-Control-Allow-Origin: *` for atproto routes. Do not rely on `PDS_CORS_ORIGIN` to change route CORS behavior in `0.8.5`.

## Cloudflare Security Rules

`com.atproto.server.refreshSession` is a valid bodyless POST. The request authenticates with `Authorization: Bearer <refreshJwt>` and does not send a JSON body.

Some Cloudflare security products treat that request shape as suspicious. This is not configured in `wrangler.jsonc`; it belongs in the production Cloudflare WAF or API Shield configuration, managed through the dashboard, Terraform/OpenTofu, or the Rulesets API.

Use a narrow exception for only the refresh route:

```txt
(http.request.method eq "POST" and http.request.uri.path eq "/xrpc/com.atproto.server.refreshSession")
```

The required action is `Skip` for `http_request_firewall_managed`. Include `http_request_sbfm` only if Cloudflare Security Events show Super Bot Fight Mode is the blocker.

If API Shield is the blocker, configure the `com.atproto.server.refreshSession` operation to accept no request body, or set mitigation to none for that operation. Do not rely on the WAF skip rule to fix an API Shield schema or mitigation problem.

## Set Secrets

Alteran's source tree has `scripts/setup-secrets.ts`, but the `0.8.5` JSR package does not publish `scripts/`. For `0.8.5`, generate the runtime secrets directly from the installed dependencies:

```sh
deno eval '
import { Secp256k1Keypair } from "npm:@atproto/crypto@^0.4.5";

const randomBase64 = (size) => {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const keypair = await Secp256k1Keypair.create({ exportable: true });
const privateKeyHex = Array.from(await keypair.export(), (byte) =>
  byte.toString(16).padStart(2, "0")
).join("");

console.log(`USER_PASSWORD=${randomBase64(24)}`);
console.log(`SESSION_JWT_SECRET=${randomBase64(32)}`);
console.log(`REPO_SIGNING_KEY=${privateKeyHex}`);
console.log(`REPO_SIGNING_DID=${keypair.did()}`);
'
```

That prints three secret values and one public identifier:

- `USER_PASSWORD` seeds the first login account
- `SESSION_JWT_SECRET` signs access and refresh JWTs
- `REPO_SIGNING_KEY` signs repository commits and service-auth JWTs
- `REPO_SIGNING_DID` is not a secret; use it to check the key represented in your DID document

Set the secret values with Wrangler:

```sh
deno task wrangler secret put USER_PASSWORD
deno task wrangler secret put SESSION_JWT_SECRET
deno task wrangler secret put REPO_SIGNING_KEY
```

Paste each generated value into the matching prompt. `REPO_SIGNING_KEY` must be a 32-byte secp256k1 private key, provided as 64 hex characters or base64. Keep these values out of `wrangler.jsonc`.

## Deploy

Wrangler can run the build command from `wrangler.jsonc`, but I still run the build locally first:

```sh
deno task build
deno task wrangler deploy
```

For `rawkode.dev`, I wrap the deploy with `cuenv` because the Cloudflare token is loaded from the production environment:

```sh
cuenv -e production exec deno task deploy
```

[`cuenv`](https://cuenv.dev/) is another tool I wrote. It uses CUE for hierarchical environment configuration, task running, and secrets. In this site, `env.cue` defines the production Cloudflare account and resolves the API token from 1Password at command runtime, so the token is not written into the repository or a local `.env` file.

## Verify the Public Endpoints

Start with health and identity:

```sh
curl -fsS https://rawkode.dev/ready
curl -fsS https://rawkode.dev/health
curl -fsS https://rawkode.dev/.well-known/atproto-did
curl -fsS https://rawkode.dev/xrpc/com.atproto.server.describeServer
```

Expected results:

- `/ready` returns `ok`; a `503` means D1 is not ready
- `/health` returns JSON with `checks.database.status` and `checks.storage.status` set to `ok`
- `/.well-known/atproto-did` returns `did:web:rawkode.dev`
- `describeServer` returns JSON with `did: "did:web:rawkode.dev"`

Check the DID document fields:

```sh
curl -fsS https://rawkode.dev/.well-known/did.json | jq '{
  id,
  alsoKnownAs,
  verificationMethod: [.verificationMethod[].id],
  service: [.service[].id]
}'
```

For this site, the output should include:

```json
{
  "id": "did:web:rawkode.dev",
  "alsoKnownAs": ["at://rawkode.dev"],
  "verificationMethod": ["did:web:rawkode.dev#atproto"],
  "service": ["did:web:rawkode.dev#atproto_pds"]
}
```

If `verificationMethod` is empty, check `REPO_SIGNING_KEY`.

Create a session:

```sh
curl -fsS -X POST https://rawkode.dev/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"rawkode.dev","password":"<password>"}'
```

A successful response includes `did`, `handle`, `accessJwt`, and `refreshJwt`.

Refresh the session with the refresh token as a bodyless POST:

```sh
REFRESH_JWT="<refreshJwt from createSession>"

curl -fsS -X POST https://rawkode.dev/xrpc/com.atproto.server.refreshSession \
  -H "authorization: Bearer ${REFRESH_JWT}"
```

Do not send `content-type: application/json` or an empty JSON object for `refreshSession`. If this request fails before reaching the Worker, check Cloudflare Security Events and add the narrow WAF or API Shield exception described above.

Then do a minimal repository write/read smoke test:

```sh
ACCESS_JWT="<accessJwt from createSession>"
RKEY="alteran-smoke-test-$(date +%s)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

curl -fsS -X POST https://rawkode.dev/xrpc/com.atproto.repo.createRecord \
  -H "authorization: Bearer ${ACCESS_JWT}" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg rkey "$RKEY" --arg createdAt "$CREATED_AT" '{
    collection: "app.bsky.feed.post",
    rkey: $rkey,
    record: {
      "$type": "app.bsky.feed.post",
      text: "Alteran smoke test",
      createdAt: $createdAt
    }
  }')"

curl -fsS "https://rawkode.dev/xrpc/com.atproto.repo.getRecord?repo=did:web:rawkode.dev&collection=app.bsky.feed.post&rkey=${RKEY}"
curl -fsS "https://rawkode.dev/xrpc/com.atproto.sync.getHead"
```

This checks auth, record writes, record reads, and the repository head. It does not prove blob upload, relay ingestion, AppView indexing, or client compatibility.

Check that the firehose route is present:

```sh
curl -i https://rawkode.dev/xrpc/com.atproto.sync.subscribeRepos
```

Without a WebSocket upgrade, the route should return `426`. For the WSS path, connect with a WebSocket client and make another record write from a second shell:

```sh
deno run -A npm:wscat -c wss://rawkode.dev/xrpc/com.atproto.sync.subscribeRepos
```

## Request Relay Discovery

Relays discover PDS hosts through `com.atproto.sync.requestCrawl`. Only request a crawl after identity, auth, writes, reads, sync, and the firehose endpoint are working over HTTPS/WSS.

```sh
curl -X POST https://bsky.network/xrpc/com.atproto.sync.requestCrawl \
  -H 'content-type: application/json' \
  -d '{"hostname":"rawkode.dev"}'
```

Do not include `https://` in the `hostname` value. A successful request does not prove federation worked; it only asks the relay to crawl the host.

## Existing Accounts

This post covers a new `did:web` setup. An existing DID can be moved to a new PDS, so a new account is not required, but that migration is a separate flow.

If you are moving an existing atproto account, do not copy the `PDS_DID=did:web:rawkode.dev` values unchanged. Keep the existing DID and update its PDS endpoint and signing material as part of the migration.

[`goat`](https://github.com/bluesky-social/goat) can help with atproto account migration. I am not covering that step by step here.

## Current Scope

Alteran is for a single-user PDS on an Astro site deployed to Cloudflare Workers.

It does not try to be a general hosting service. It also does not make a static Astro deployment into a PDS; the PDS routes need request-time code and Cloudflare bindings.

Existing DID/account migration is outside the scope of this article.

D1 and R2 are now part of the site state. Back them up before using this account for data you want to keep.

Review the generated routes, Wrangler bindings, and database migrations when updating Alteran.

## References

- [Alteran](https://github.com/alteran-social/alteran)
- [AT Protocol DID specification](https://atproto.com/specs/did)
- [AT Protocol handle specification](https://atproto.com/specs/handle)
- [AT Protocol sync guide](https://atproto.com/guides/sync)
- [Astro on Cloudflare Workers](https://developers.cloudflare.com/workers/frameworks/framework-guides/web-apps/astro/)
