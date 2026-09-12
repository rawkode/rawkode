# e2

A Deno workspace of Cloudflare Workers, deployed with Alchemy v2.

| Worker                        | Responsibility                                                                             | Deployment                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| `apsides-core-documents`      | Owner-scoped daily notes in Durable Object SQLite                                          | `core/documents/alchemy.ts`      |
| `apsides-api`                 | Composed GraphQL queries over owner-scoped integration services                            | `api/alchemy.ts`                 |
| `apsides-website`             | Account management, Google contacts and events, authenticated gateway                      | `website/alchemy.ts`             |
| `apsides-integrations-oauth`  | Google/GitHub OAuth, encrypted credentials and tokens, service grants                      | `integrations/oauth/alchemy.ts`  |
| `apsides-integrations-google` | Calendar/contact mirrors, Gmail search and notifications, account sync                     | `integrations/google/alchemy.ts` |
| `apsides-integrations-github` | OAuth-backed profile, repository, issue, pull request, discussion, and Today activity data | `integrations/github/alchemy.ts` |

`naming.ts` defines the shared `apsides-` Worker prefix and full stage suffix
rule. Each deployment uses `workerName(logicalName, stage)`.

Each Worker defines its own resources, bindings, secrets, migrations, and
schedules. The root `alchemy.run.ts` imports and connects these definitions in
one stack. Production (`--stage production`) uses the exact Worker names above;
other stages append `-<stage>`. D1 databases and Alchemy state remain
stage-specific. Secret names also include the stage, within the account-wide
Secrets Store.

## Development

Install Deno 2.9+ and Node 22.15+ (Node 24+ recommended). Run from `apps/e2`:

```sh
deno install
deno task verify
deno task build
deno task smoke
deno task smoke:website
```

Deno manages dependencies with `deno.lock`, runs TypeScript checks, formats and
lints the code, and runs tests. Node runs Alchemy's published CLI and local
Worker runtime, which support Node/Bun rather than Deno. The pinned Alchemy
version is `2.0.0-beta.76`, with Effect `4.0.0-rc.112`. Drizzle Kit and ORM are
pinned to `1.0.0-rc.4`, whose timestamp-directory migration format is supported
by Alchemy.

The small `package.json` files provide Node-compatible workspace resolution for
Alchemy's bundler. They do not introduce a second package manager or lockfile.
The lint configuration excludes `no-slow-types`, a JSR publishing requirement;
these Worker packages are not being published to JSR.

`build` uses the pinned Alchemy release's Worker bundler without cloud
credentials. `smoke` starts temporary local Workers from those bundles and
removes its state on completion. These scripts use Alchemy's internal APIs;
revalidate them when upgrading Alchemy. Unit/regression tests use SQLite and
loopback provider mocks.

Business logic uses arrow-function factories. Framework-required RPC/Worker and
Durable Object classes contain thin prototype adapters.

## Configuration and deployment

`env.cue` resolves Google and GitHub OAuth credentials plus the Cloudflare
deployment token directly from 1Password and supplies the website domain.
Deployment code derives its HTTPS origin from `WEBSITE_DOMAIN`:

| cuenv environment | Alchemy stage | Website                           |
| ----------------- | ------------- | --------------------------------- |
| `development`     | `development` | `https://apsides.rawkode.dev`     |
| `production`      | `production`  | `https://apsides.rawkode.academy` |

Run from `apps/e2` with 1Password authentication available to cuenv. The
configured Cloudflare token must cover the account that owns both zones:

```sh
cuenv -e development exec -- deno task plan --stage development
cuenv -e development exec -- deno task deploy --stage development
# Production:
cuenv -e production exec -- deno task plan --stage production
cuenv -e production exec -- deno task deploy --stage production
```

The account must have Cloudflare Zero Trust enabled with a working identity
provider (email one-time PIN is sufficient). Alchemy discovers its team domain
and creates an Access application for each website, allowing
`david@rawkode.academy`. The website validates the Access JWT and derives
account ownership from its subject. Access audience and team domain are wired
automatically; no manually copied audience value is needed.

Register both exact Google OAuth redirect URIs:

- `https://apsides.rawkode.dev/oauth/callback/google`
- `https://apsides.rawkode.academy/oauth/callback/google`

Register these exact GitHub OAuth callback URLs on the GitHub OAuth app:

- `https://apsides.rawkode.dev/oauth/callback/github`
- `https://apsides.rawkode.academy/oauth/callback/github`

The managed GitHub app requests `read:user user:email`. This is enough for
account identity, email, and public activity. Do not add the classic OAuth
`repo` scope unless private repository data is required; it grants broad
read/write repository access. A GitHub App with read-only repository permissions
is the safer path for private repository enrichment.

Enable Calendar, People, and Gmail APIs in the Google project and grant your
Google user access to the consent application. After deployment, open the
website, sign in through Access, choose **Connect Google**, complete consent,
and use **Enable sync**. The account coordinator starts immediately and repeats
roughly every 15 minutes, with retry/backoff and continuation for paginated
sync. Contacts and calendar events are available from the Google page.

Optional Gmail push settings can be supplied in `.env`; they are not needed for
contacts/events sync. `.envrc` and `.env` are ignored. Never store secret values
in tracked files. Planning/deployment need Cloudflare permissions for Workers,
custom domains, D1, Durable Objects, Secrets Store, Access applications, and
reading the existing Access organization.

Alchemy generates and persists three application secrets: an OAuth encryption
keyring and a separate credential for each integration. The account-wide Secrets
Store holds these under stage-qualified names. Alchemy also copies the cuenv-
resolved Google and GitHub credentials into Secrets Store and binds them only to
OAuth. 1Password remains their source of truth: run deployment through cuenv
again to propagate a rotation. No application secret values or credential hashes
belong in `.env`.

Each integration owns its credential resource in its `alchemy.ts`. OAuth binds
both credentials to authenticate callers; each integration binds only its own.
OAuth also binds `TOKEN_KEYRING`, a secret JSON document containing
`{ "active": "primary", "keys": { "primary": "<base64 AES key>" } }`. The
Workers call the native secret binding's `.get()` method. The active key ID is
part of that document, so there is no separate encryption-key-ID setting.

Stable Alchemy Random resource IDs preserve the generated values across deploys.
Do not discard their state or replace an encryption key without retaining old
keys. To rotate, update the managed keyring definition to include new key
material and select its ID, keeping previous key entries until stored ciphertext
has been re-encrypted. Changing Secrets Store values outside Alchemy is
reconciled back to the declared values on the next deployment. Runtime reads do
not indefinitely cache secrets; credential rotation invalidates retained RPC
capabilities, including requests still refreshing tokens.

Generated and 1Password-sourced secret material also lives in Alchemy state. The
selected Cloudflare state backend encrypts that state; local state and exported
state still need to be kept private. Secrets Store replaces per-Worker secret
values in configuration, not the OAuth database's token encryption or
per-account grants.

The managed Google app (`google`) reads its client credentials from Secrets
Store and requests identity/profile plus read-only Calendar, contacts, other
contacts, Workspace directory, and Gmail access. Other contacts and directory
API operations are not yet implemented. Existing connections must reconnect to
grant the expanded scopes; updating app metadata does not expand issued grants.
OAuth stores its metadata in D1 when first used, without copying its client
secret there. Its client ID is pinned once registered; replacing the Google
OAuth application requires a deliberate connection migration, rather than
reusing refresh tokens issued to another client. Rotating the same client's
secret is supported.

Additional OAuth apps can still be registered through `OAuthAdmin`; their client
secrets are encrypted in OAuth's D1 database. Connections require explicit
grants to each integration service. Access token expiry is `null` for
nonexpiring GitHub tokens. Both GitHub and Google support refresh where the
provider issues a refresh token.

The GitHub Worker is read-only, although GitHub OAuth's repository scopes also
permit writes at the provider level. It performs bounded pages of 50 records and
never follows arbitrary upstream pagination URLs. Issue lists exclude pull
requests and retain the upstream page cursor; an issue page can therefore be
empty while `nextPage` remains set. GitHub App installations, webhooks, and
persistent GitHub mirroring are not part of this initial integration. Today
activity is limited to issues, pull requests, and discussions; unsupported
events such as pushes are ignored. A managed GitHub app appears when
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are bound in Secrets Store.

## Entry points and routing

The website is the public gateway on its configured custom domain; all
`workers.dev` and preview URLs remain disabled. Internal admin RPC entrypoints
are available only through service bindings. Browser POST actions verify the
request origin, and OAuth callbacks preserve the browser-binding cookie and
PKCE/state checks. Client-supplied owner headers are never trusted.

The website migrates the Enchiridion integration-admin shell and account flows.
The home page uses the selected web-rich-editor spike and the shared
`.native-note` Tiptap JSON format. Today uses the browser-local date and remains
a draft until the first edit. Notes are stored per owner by `core/documents`;
revision checks stop stale tabs from overwriting newer content. Import/export
preserves the same format. Remote link metadata discovery is not exposed by this
deployment. Integration manifests register command palette actions and `@`
entities without coupling the website to a provider's Worker. Google contributes
people and events plus stub create commands; GitHub contributes issue, pull
request, and discussion entities. The Today sidebar shows calendar events,
people from events or today's mentions, and supported GitHub activity. Selecting
a GitHub activity can insert a stable entity mention with the chosen Google
contact metadata. Event instance pages have their own documents, while the
series page lists the instance-note feed. GitHub app registration and OAuth
connections remain available; the GitHub integration backend continues to expose
read APIs to trusted callers.

Deleting a Google account first clears that account's Durable Object tables and
alarms, preserving only a deletion marker and migration bookkeeping, then
removes its OAuth connection/tokens/grants. Cleanup accepts expired or ungranted
accounts, is retryable, and fences in-flight writes from recreating data. Use
the website deletion action for this coordinated lifecycle; calling raw
`OAuthAdmin.disconnect` alone does not erase the separate mirror. Revoking a
grant or requiring reauthentication pauses sync without permanently deleting the
account's object.

Gmail push still requires a public notification route and Pub/Sub settings; it
is not needed for scheduled contacts/events syncing.

## GraphQL API

The layout is `website/`, `api/`, `core/documents/`, and
`integrations/{oauth,google,github}/`. The website proxies same-origin POST
requests at `/api/graphql` to the private API Worker. Both validate the signed
Access identity; account ownership never comes from a query argument or
caller-supplied owner header.

Each integration owns a `graphql.ts` extension of the shared `User` type.
`api/integrations.ts` composes enabled modules at deployment time. Modules do
not import one another; disabling one removes its fields from the schema.
Resolvers call native Worker service bindings. This is static schema
composition, not runtime federation or automatic discovery of deployed Workers.

For example, list the signed-in user's connected Google accounts:

```graphql
query Accounts {
  me {
    googleAccounts {
      id
      accountLabel
    }
  }
}
```

Then select one account and page its contacts:

```graphql
query Contacts($connectionId: ID!, $after: String) {
  me {
    googleAccount(connectionId: $connectionId) {
      contacts(after: $after) {
        records { id displayName emails phones }
        nextCursor
      }
    }
  }
}
```

The API also exposes Google calendars/events, Today events/people, GitHub
repositories, and supported GitHub activity. Queries have size, depth,
complexity, and service-call limits. Account mutations continue through the
website's existing authenticated actions.

## Database schema and migrations

Each database-owning Worker has `schema.ts`, `drizzle.config.ts`, and
`migrations/`. Edit the TypeScript schema and generate SQL before reviewing and
deploying it:

```sh
deno task db:generate
# Or generate a named migration for one Worker:
deno task db:generate:oauth --name add_oauth_field
deno task db:generate:google --name add_google_field
deno task verify
deno task smoke
cuenv -e production exec -- deno task deploy --stage production
```

Check in Drizzle's generated `migration.sql` and `snapshot.json` files together.
Do not hand-edit generated SQL or snapshots. Alchemy applies OAuth's D1
migrations and tracks them in `__alchemy_migrations`.

Google and Documents have no D1 database. Documents uses Drizzle-generated
metadata and content-chunk tables in each owner’s Durable Object, keeping large
notes within SQLite row limits. `db:generate:documents` generates and bundles
its migrations in the same way as Google. Reads never create a document row.

Google has no D1 database. Each `GoogleAccount` object owns SQLite records,
cursors, and watch metadata. Both DO Drizzle configs use
`driver: "durable-sqlite"`. Drizzle Kit generates `migrations/migrations.js`
importing its SQL; Alchemy bundles those text modules. Drizzle’s standard
Durable Object migrator applies them at object startup and tracks
`__drizzle_migrations`. Google includes a one-time validated adoption of an
account Durable Object that already carries the legacy `__account_migrations`
journal, such as a local or preview object being moved to this layout. There is
no custom JSON bundle or SQL migration executor. D1 migrations still run through
Alchemy at deploy time.

## Migration boundary

OAuth and Google source, schemas, contracts, and regression tests were migrated
from `apps/enchiridion` at jj revision `7d106fd0`. Those source files were
absent from the current working tree; the existing deletions and local
credentials/state were left untouched.

The initial handwritten e2 migrations were replaced by Drizzle-generated
baselines before any e2 deployment. This is a fresh baseline, not an upgrade
migration for an existing e2 production database. Existing production tokens,
grants, calendar data, and Durable Object state have not been transferred, and
old Enchiridion deployments remain untouched. The adoption path protects legacy
account objects if one is deliberately moved into this deployment; transferring
existing remote data still requires a separate staging migration.

The website runtime harness uses the production Astro bundle, signed fixture
Access JWTs, and fixture native service bindings. Backend smoke independently
exercises real OAuth/DO bindings and mocked Google HTTP responses, including a
delete during a delayed sync response. These checks do not replace a live
consent-to-sync acceptance run.

Local checks establish build, migration SQL/application, mocked provider, and
Worker runtime behavior. Real Google/GitHub consent, production data migration,
and live Cloudflare deployment remain separate validation steps.
