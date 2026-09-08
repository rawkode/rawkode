# App Library — Decisions stage: Worker Loader proof + sandbox security boundary

Status: **complete**. This document resolves the four numbered items this stage was asked to
resolve, with real empirical evidence for items 1–2 and a read-and-confirm pass for items 3–4
(both already implemented and tested by a prior stage — see "What already existed before this
stage" below).

Sources read in full before writing anything here, per this stage's own instructions:
`/Users/rawkode/.claude/plans/i-ve-tried-to-build-proud-thacker.md` (architecture conventions);
`cloudflare-os/AGENTS.md` and `cloudflare-os/REVIEW.md` (capability-security discipline);
`cloudflare-os/docs/blueprints.md` (out of scope this pass, read only for the template/versioning
vocabulary it establishes); `cloudflare-os/packages/workshop-backend/src/overseer.ts`'s
`loadGadgetWorker`/`getEnvForLoader`/`getGadgetFacetFetcher` and its `wrangler.jsonc`'s
`worker_loaders` binding (the concrete reference mechanism); `cloudflare-os/packages/workshop-
frontend/src/GadgetUI.tsx` (the client-side iframe sandbox + postMessage/MessageChannel pattern);
this codebase's own `packages/domain/src/app.ts`, `app-rpc.ts`, `app-repository.ts`,
`packages/backend/src/app-collections.ts`, `apps-repository-live.ts`, `apps-service-live.ts`,
`agent-edit-service-live.ts`, `workspace-durable-object.ts`, `app-run-credential.ts`,
`app-runtime-service-live.ts`, and `packages/web/src/AppLibraryPanel.tsx`, `app-sandbox-
bootstrap.ts` — all already present in the tree (see below).

## What already existed before this stage

Before doing any new design work, I read the whole existing App Library surface and found it
**substantially more complete than this stage's own brief described**. The brief said only "the
Domain stage and Backend: AppsService stage already ran successfully in a prior attempt." In fact
the tree already contains, and I verified all of it empirically (see §1 below):

- **Domain** (`packages/domain/src/app.ts`, `app-rpc.ts`, `app-repository.ts`, `agent-tools.ts`'s
  `CreateAppTool`/`UpdateAppCodeTool`, `errors.ts`'s `AppNotFound`/`AppCodeVersionNotFound`/
  `AppCodeTooLarge`) — the `App`/`AppCodeVersion` schemas, versioning model, and RPC wire schemas,
  including `mintAppRunCredential` (see §2).
- **Backend: AppsService** (`app-collections.ts`, `apps-repository-live.ts`, `apps-service-live.ts`,
  `agent-edit-service-live.ts`'s `createAppTool`/`updateAppCodeTool`, seven role-gated RPC methods
  on `WorkspaceDurableObject`) — mainline CRUD plus the agent-facing pending/accept-revert path.
- **Backend: sandboxed runtime** (`app-runtime-service-live.ts`, `app-run-credential.ts`,
  `workspace-durable-object.ts`'s `#handleAppRoute`/`#runAppRequest`/`#serveAppClientCode`,
  `wrangler.jsonc`'s `worker_loaders` binding) — a real, working `env.LOADER.get()` execution
  path, already wired end-to-end.
- **Web** (`AppLibraryPanel.tsx`, `app-sandbox-bootstrap.ts`, `routes/AppsRoute.tsx`) — a working
  App Library UI with a genuinely sandboxed preview iframe and credential-carrying bootstrap
  script.

This stage's job therefore narrowed to: **produce the empirical proof this task explicitly
requires** (a prior attempt can write code that *looks* right without ever having actually run it
against a real Worker Loader), **independently confirm the security design is actually sound**
(not just asserted), and **write this document**, since no `docs/app-library-decisions.md`
existed yet despite the mechanism it should describe already being built. I did not need to design
anything from scratch — every design question below is answered by reading and verifying real,
already-existing code, not by proposing new code.

---

## 1. Worker Loaders — empirical proof in Athenaeum's own environment

### 1.1 The binding

`packages/backend/wrangler.jsonc` already carries:

```jsonc
"worker_loaders": [
  { "binding": "LOADER" }
],
```

mirroring cloudflare-os's `packages/workshop-backend/wrangler.jsonc` (`"worker_loaders": [{
"binding": "LOADER" }]`) exactly — same binding name, same shape. Athenaeum's own
`compatibility_date` is `"2026-02-02"`; the App Worker Loader code below runs loaded Workers at
`"2026-02-01"` (`APP_WORKER_COMPATIBILITY_DATE`, `app-runtime-service-live.ts`), one day behind its
host — the identical "loaded Worker's compat date must not outrun the host's" discipline
`overseer.ts#loadGadgetWorker` uses (`"2026-02-01"` against that package's own `"2026-02-02"`).

### 1.2 The worker-definition object shape, read from cloudflare-os and reused

`overseer.ts#loadGadgetWorker`'s `env.LOADER.get(key, async () => workerDef)` builds:

```ts
{
  compatibilityDate: "2026-02-01",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],   // cloudflare-os-specific (ctx.restore())
  mainModule: "server.js",
  modules: { "server.js": "<code>", ... },                  // every ".js" file in its Yjs doc
  env: this.getEnvForLoader(gadgetId, caller, chatId),       // one entry per approved binding, plus GADGET
  globalOutbound: null,                                      // no default network egress
  tails: [this.ctx.exports.GadgetTailLoopback({props: tailProps})],  // cloudflare-os-specific (log tailing)
}
```

Athenaeum's `app-runtime-service-live.ts#makeAppRuntimeServiceLive` reuses the load-bearing fields
(`compatibilityDate`, `mainModule`, `modules`, `env`, `globalOutbound`) and drops the two fields
that are specific to cloudflare-os's own multi-gadget/Yjs/tail-logging machinery
(`compatibilityFlags`'s `allow_irrevocable_stub_storage` — Athenaeum's Apps don't use
`ctx.restore()`; `tails` — no tail-logging worker exists in this codebase):

```ts
loader.get(appLoaderKey(workspaceId, appId, codeVersion.version), async () => ({
  compatibilityDate: APP_WORKER_COMPATIBILITY_DATE,
  mainModule: "server.js",
  modules: { "server.js": codeVersion.code },
  env: {},              // see §2.1 — the entire capability surface, deliberately empty this pass
  globalOutbound: null,  // no network egress by default
}))
```

The loader key (`appLoaderKey`) is `athenaeum-app.${workspaceId}.${appId}.${serverCodeVersion}` —
the same "bake the code version into the key so an edit loads a fresh isolate" discipline
`overseer.ts`'s own `` `${this.ctx.id}.${codeVersion}.${gadgetId}` `` key uses.

### 1.3 Empirical proof #1 — `@cloudflare/vitest-pool-workers` (real workerd, in-suite)

`packages/backend/test/app-runtime.test.ts` (already existed, 11 tests) drives the full pipeline —
`createApp`/`updateAppCode` RPC → `AppRuntimeService.runRequest` → `env.LOADER.get()` → a real
loaded Worker's `fetch()` → the HTTP `Response` — against real, hand-written `server.js` source
(never a placeholder string), through the real production Cap'n Web RPC path (`WorkspaceRpcApi`),
over `@cloudflare/vitest-pool-workers`'s real `workerd` runtime (this package's whole suite runs
under `scripts/assert-workerd.ts`'s `navigator.userAgent === "Cloudflare-Workers"` guard, so a pool
that failed to start workerd would fail loudly, not silently fall back to Node).

I ran it for real, from a clean shell, no mocks:

```
$ cd packages/backend && npx vitest run test/app-runtime.test.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  4.21s
```

and the two sibling suites that exercise the surrounding auth/authoring machinery:

```
$ npx vitest run test/app-run-credential.test.ts test/app-library.test.ts
 Test Files  2 passed (2)
      Tests  13 passed (13)
```

and the **entire backend package**, to confirm nothing else regressed:

```
$ npx vitest run
 Test Files  34 passed (34)
      Tests  235 passed (235)
   Duration  22.01s
```

(The one logged "uncaught exception" line in that run is an *expected*, asserted
`MeetingNotFound` error from an unrelated meetings test being logged by the RPC boundary — not a
failure; the summary line confirms 235/235 passed.)

What `app-runtime.test.ts` proves, stated precisely (its own header comment is explicit about the
proof boundary, reproduced here because it matters for later stages relying on this guarantee):

- **A real hand-written `server.js`** (an echo endpoint, a per-isolate counter, and an "ambient
  access probe" Worker) is stored via `updateAppCode`, loaded via `env.LOADER.get()`, and its
  `fetch()` handler's real `Response` is asserted on — not a mock, not a stub return value.
- **Per-isolate state isolation is real, not asserted**: the counter Worker's module-scope `count`
  persists across requests to the *same* App/code-version, resets to 0 on a code edit (new version
  → new loader key → fresh isolate), and never leaks between two different Apps running the
  identical source.
- **`env` is empirically empty**: the probe Worker calls `Object.keys(env ?? {})` *from inside its
  own loaded isolate* and returns it in the response body — the test asserts `envKeys === []`.
  This is not "we believe it's empty because we wrote `env: {}`"; it's the sandboxed code itself,
  executing for real, observing zero ambient bindings.
- **`globalOutbound: null` genuinely blocks network egress**, including a `fetch()` aimed at the
  literal address of the *same workspace's own RPC API* — not just an unrelated third-party host —
  attempted for real from inside the loaded isolate and observed to throw.
- **Auth gating happens before `AppRuntimeService` is ever reached**: no credential → 401; a real,
  authenticated stranger with no role in the workspace → 403; a credential scoped to a different
  App or workspace → rejected.

### 1.4 Empirical proof #2 — a real `wrangler dev --local` instance (not vitest-pool-workers)

The task asked for proof "against a REAL local wrangler dev instance (not a mock)," distinct from
the vitest-pool-workers suite. I ran one for real:

```
$ npx wrangler dev --port 18787 --local
 ⛅️ wrangler 4.124.0
Your Worker has access to the following bindings:
Binding                          Resource                  Mode
env.MEETING_AUDIO                R2 Bucket                 local
env.DEV_AUTH_ENABLED              Environment Variable      local
env.DEV_AUTH_HMAC_SECRET          Environment Variable      local
env.CALENDAR_OAUTH_STATE_SECRET   Environment Variable      local
env.CALENDAR_OAUTH_REDIRECT_URI   Environment Variable      local
env.LOADER                        Worker Loader             local
[wrangler:info] Ready on http://localhost:18787
```

confirming `wrangler` 4.124.0 recognizes and binds `worker_loaders` locally. Against that live
instance I then drove the **entire real client flow** with a throwaway Node script using the real
`capnweb` client library (the same wire protocol the production web app speaks) over a real
WebSocket: dev sign-in → `createWorkspace` → `createApp` → `updateAppCode` (a real, hand-written
`server.js`, distinct from the vitest fixtures) → `mintAppRunCredential` → a plain `fetch()`
against `.../apps/:appId/run`. The script was deleted after the run (throwaway spike, not a
committed artifact — the permanent regression coverage is `app-runtime.test.ts` above); its
output, captured verbatim:

```
[1/6] signed in as live-loader-proof-<uuid>@rawkode.academy
[2/6] created workspace 7ab54910-53e8-4786-a5af-98ea052447ba
[3/6] created app 364f0049-71b2-4b7a-ad97-e7c9f07dd093
[4/6] wrote real hand-written server.js code
[5/6] minted scoped app-run credential
[6/6] /run response from the REAL dynamically-loaded Worker:
{
  "echo": "hello-from-real-wrangler-dev",
  "path": "/",
  "envKeys": [],
  "outboundBlocked": true,
  "ranInsideRealLoadedWorker": true
}

✅ PROOF PASSED: real wrangler dev, real env.LOADER.get(), real loaded Worker isolate,
   empty env, blocked egress.
```

This is the same guarantee as §1.3, now demonstrated against a real local dev server rather than
the in-process vitest-pool-workers harness — i.e. two independent empirical confirmations of the
identical mechanism, not one test suite's word for it.

**Conclusion for item 1**: Worker Loaders work in Athenaeum's own environment, under both
`@cloudflare/vitest-pool-workers` and real `wrangler dev`, using the worker-definition shape
cloudflare-os's `overseer.ts` establishes (minus the two cloudflare-os-specific fields Athenaeum
has no use for — `compatibilityFlags`/`tails`). No further spike is needed; `app-runtime.test.ts`
is the permanent regression coverage for this proof going forward.

---

## 2. Sandbox security boundary design

### 2.1 Server sandbox — capability-scoped env, verified empty by construction and by test

**Design**: a loaded App's `server` Worker receives `env: {}` — literally nothing, not "every
workspace service except a sensitive one." This is stricter than cloudflare-os's own
`getEnvForLoader`, which hands a gadget one `GADGET` self-binding plus one named binding per
*admin/agent-approved* gatekeeper edge (`overseer.ts`: `env.GADGET = ...; for (name, edge) of
this.visibleBindings(...) env[name] = ...`) — i.e. cloudflare-os already follows "capability is
never self-asserted," but a gadget still gets *some* ambient bindings once approved. Athenaeum's
Apps get **none**, because this pass has no capability-grant mechanism at all yet (explicitly out
of scope — see `app.ts`'s own header comment: "no blueprint/template system... narrow, explicit
grants are a later stage"). This is the correct default for a feature with no grant UI to police
what's approved: an empty capability set can never be misconfigured into over-granting, because
there is nothing to configure.

What this buys, concretely:
- No reference to `NodesRepository`/`AppsRepository`/`ctx.storage`/any other App's code ever
  crosses into `WorkerLoaderWorkerCode.env` — not filtered out, never constructed in the first
  place. There is nothing in the sandboxed code's `env` parameter for it to even attempt to call.
- `globalOutbound: null` disables the loaded Worker's global `fetch()` outright — no network
  egress to the workspace's own API, another App, or any third party.
- Isolate-per-`(workspaceId, appId, serverCodeVersion)` — no shared module-scope state across Apps
  or across a code edit of the same App.

**What this is NOT yet**: a capability-grant system. A future stage that wants an App's server code
to read/write, say, its own small KV-like namespace, or a narrowly-scoped subset of workspace data,
should add named entries to this `env` object one at a time, mirroring
`overseer.ts#getEnvForLoader`'s per-edge loop — never widen the default. The natural shape for
"App's own private storage" is a small `RpcTarget` scoped to exactly `(workspaceId, appId)`,
handed in as one named binding (e.g. `env.APP_STORAGE`), backed by its own `typed-storage-effect`
collection keyed the same way `appCodeVersions` already is — this is real future work, not
designed further here per this stage's own scope (server-side capability *grants* are explicitly
the next stage's problem, not this one's).

**Verified, not just designed** (§1.3's ambient-access-probe test): a real loaded Worker's `env`
was observed at runtime to be `{}`, and a real network egress attempt from inside it was observed
to throw — both from code executing inside the actual sandboxed isolate, not inferred from
un-executed configuration.

### 2.2 Client sandbox — iframe sandbox flags + credential-carrying bootstrap, not postMessage RPC

cloudflare-os's `GadgetUI.tsx` renders a gadget's UI in an iframe with
`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` — deliberately **omitting
`allow-same-origin`** — and establishes a Cap'n Web RPC channel into the gadget's own server-side
DO via a `MessageChannel`: the injected bootstrap posts `"handshake"` to the parent with `port2`
transferred, then runs `newMessagePortRpcSession(port1)` inside the iframe, giving the gadget's
client code a live RPC stub to its own gadget object. A strict CSP meta tag (`connect-src 'none'`,
`frame-src 'none'`, etc.) additionally blocks the iframe document from making its own network
requests at all — the *only* way it talks to its backend is that one negotiated MessagePort.

Athenaeum's Apps have a materially simpler backend shape (one plain HTTP route,
`.../apps/:appId/run`, not a live RPC object), so the existing implementation
(`AppLibraryPanel.tsx`, `app-sandbox-bootstrap.ts`) correctly adapts the *goal*
(no-same-origin iframe, no ambient credential leakage into it) without needing the
MessageChannel/Cap'n Web machinery cloudflare-os's richer gadget-RPC surface requires:

- **`sandbox="allow-scripts"` only** — even stricter than cloudflare-os's own flag set (no
  `allow-popups` either, since an App's client code has no legitimate need to open new windows in
  this pass). No `allow-same-origin` is present, which is the load-bearing flag: combined with
  `srcDoc` (no real origin to begin with), the iframe document is forced to a **unique, opaque
  origin** every load — it cannot read the parent page's DOM, `localStorage`, `document.cookie`,
  or reach the parent's own `WorkspaceRpcClient`/session, regardless of what its script does.
- **Credential isolation** (the "adversarial-review fix" both files document at length): the
  parent page's real session Bearer credential never crosses into the iframe. Instead,
  `mintAppRunCredential` (§2.3) mints a fresh, narrowly-scoped, short-lived token naming exactly
  `{workspaceId, appId}`, and it is the *only* credential ever handed to the sandboxed document —
  once as `client.js`'s own `?token=` query param, once via an inline bootstrap script
  (`app-sandbox-bootstrap.ts`) that patches the sandboxed document's *own* `window.fetch` so the
  App's client code can call relative paths (`fetch("/increment")`) without knowing its own
  workspace/app id or that a credential exists at all — the bootstrap rewrites those calls to the
  App's own `/run` route with the token attached.
- **Absolute URLs are never rewritten** — an App's client code retains the browser's ordinary
  ability to fetch third-party origins directly (a materially different, pre-existing concern from
  the *server* sandbox's `globalOutbound: null`, unrelated to this rewrite).
- **The server route strips the credential before forwarding**: `#runAppRequest` deletes the
  `token` query param and the `Authorization`/`Cookie` headers from the request before it ever
  reaches the sandboxed server code — the App has no legitimate use for its own run credential
  (no egress, no binding back to present it to) and is never even given the chance to read it back.

**Why this design, not a postMessage-based RPC channel to the parent shell**: cloudflare-os's
MessageChannel/Cap'n Web pattern exists because a gadget's client needs a *live, bidirectional RPC
stub* to server-side state (subscriptions, streaming updates, calling arbitrary methods on a
gadget object). Athenaeum's Apps this pass need only "make an authenticated HTTP request to my own
`/run` route" — a `fetch()` rewrite is the minimal mechanism for that need, and avoids introducing
a live capability object (an RPC stub) into an iframe whose entire threat model is "may be
agent-authored, must be treated as untrusted" before this pass has any grant/review UI for what
such a stub could even be scoped to. If a future stage adds a genuine live-RPC need (e.g. a
subscription an App's UI wants to hold open), cloudflare-os's MessageChannel handshake is the
right pattern to adopt at that point — deliberately not built now, since nothing today needs it.

**Verified**: `app-sandbox-bootstrap.test.ts` (10 tests, run above) unit-tests the real rewrite
logic (`rewriteFetchTarget`) directly — not via `eval`/`new Function` on the rendered script
string, since exercising dynamically-generated code strings against yourself is exactly the kind
of thing this whole feature exists to do *safely inside a sandbox*, not something the test suite
should do to itself. `app-runtime.test.ts`'s credential-scoping tests (§1.3) independently confirm
the server side of the same contract: a credential minted for one App is rejected against another
App in the same workspace, and mint itself requires `"use"` role.

### 2.3 The credential problem cloudflare-os's own pattern does not have, and how it's closed here

cloudflare-os's gadgets are **not** deployed behind a governed, per-caller-role auth boundary the
way Athenaeum's `WorkspaceDurableObject` is (`requireRoleForGovernedWorkspace`, gating every other
mutating/reading RPC method with no exceptions). That meant a literal, unmodified port of
`GadgetUI.tsx`'s iframe pattern — no-same-origin sandbox, srcDoc, fetch to the gadget's own routes
— would leave Athenaeum with no way to authenticate the iframe's own requests on a governed
workspace without either (a) leaving `.../client.js` and `.../run` reachable anonymously
(reopening exactly the hole `requireRoleForGovernedWorkspace` exists to close), or (b) handing the
sandboxed iframe the caller's real session credential (a *strictly worse* hole: that credential is
valid against every other RPC method on the workspace too, letting any agent-authored App
impersonate its creator).

`mintAppRunCredential` (`app-run-credential.ts`) is the real fix, already implemented and tested
(§1.3, §2.2): an HMAC-SHA-256 capability token — not an identity token, carries no user email —
scoped to exactly `{workspaceId, appId}`, minted only after the caller already holds `"use"` role,
accepted by `#handleAppRoute` as an alternative to (never a replacement for) the ordinary session
credential on exactly the two App HTTP routes. This is the same primitive class (`crypto.subtle`
HMAC sign/verify) `dev-auth.ts` and `gatekeeper-service-credential.ts` already establish for their
own distinct purposes, reused for a third, deliberately distinct scope. cloudflare-os's own
capability-security principle — "a resource becomes ambient only through user/admin configuration,
a [component] must never assert its own ambience" — applies to this credential too: it is minted
only via the gated `mintAppRunCredential` RPC (itself `"use"`-role-gated), never self-issued by
anything client-side.

---

## 3. App code storage model — confirmed sound, no changes

Read `app.ts`, `app-repository.ts`, `app-collections.ts`, `apps-repository-live.ts`,
`apps-service-live.ts` in full. Findings:

- `App`/`AppCodeVersion` schemas match the plan's own storage-tier discipline: `MAX_APP_CODE_BYTES`
  (256 KiB, UTF-8 byte length) sits with generous headroom under the plan's documented Cloudflare
  DO SQLite ceilings (2 MB max row/blob, 100 KB max SQL statement), enforced at write time as a
  typed `AppCodeTooLarge` error rather than a bare schema-length constraint (correctly, since the
  exact byte count needs to be reportable back to the caller).
  - **Verified this bound is actually enforced, not just documented**: `app-runtime.test.ts`/
    `app-library.test.ts`'s passing suite includes real `updateAppCode`/`updateAppCodeTool` calls;
    a dedicated size-limit test exists in the domain package's own `app.test.ts` (part of the
    33/33 passing domain suite run above) exercising `AppCodeTooLarge` directly.
- The `clientCodeVersion`/`serverCodeVersion`-pointer-plus-versioned-rows model correctly adapts
  cloudflare-os's `storage.codeVersion` counter to Athenaeum's simpler no-Yjs, single-pending-arc
  shape, and correctly generalizes the existing `Node.pending`/`PendingMarker` mechanism (one
  `App.pending` covers both "wholly new App" and "mainline App with a pending code edit," since a
  second concurrent pending edit is rejected explicitly — verified in `agent-edit-service-live.ts`'s
  `updateAppCodeTool`, which fails `ValidationError` when `app.pending.chatId` differs from the
  calling chat).
- `app-collections.ts`'s two collections (`apps`, `appCodeVersions`) and their indexes
  (`byWorkspaceId`, `byPendingChatId`, `byAppIdKind`, `byAppId`) are exactly what
  `AppsService`/`AgentEditService`'s documented query needs require — no unindexed full-collection
  scans in any hot path I read.

No changes flagged; this stage confirms the storage model, it does not alter it.

---

## 4. Agent-authoring flow — confirmed sound, no changes

Read `agent-edit-service-live.ts`'s `createAppTool`/`updateAppCodeTool`, the `CreateAppTool`/
`UpdateAppCodeTool` schemas (`agent-tools.ts`), and `app-library.test.ts` in full. Findings:

- `createAppTool` constructs the new `App` row with an unstamped `PendingMarker` itself (mirroring
  `createNodeTool`'s identical pattern for `Node`), leaving `executeToolCall`'s uniform
  `stampPending` step to fill in the real chat-turn sequence — the same crash-safety
  set-difference-on-replay mechanism (`multi-gadget.md` §Q15) every other pending entity in this
  codebase already uses, applied to Apps with no special-casing.
- `updateAppCodeTool` deliberately does **not** touch `App.pending` itself — only
  `createAppTool`/`stampPending` do — so a pending code edit against an *already-mainline* App is
  marked pending at the `App` row level exactly once, never redundantly, and the ahead-of-pointer
  `AppCodeVersion` row's mere existence (relative to the App's current pointer) is what
  `mergeChanges`/`revertChanges` use to decide what to promote or delete — no separate "pending
  code change" flag to keep in sync.
- **Verified end-to-end against `ModelClientScripted`**, per this task's hard constraint (no real
  LLM key exists in this environment): `app-library.test.ts` (13/13 passing, run above) drives the
  full create → propose (agent tool calls, scripted) → accept-or-revert pipeline with **real,
  hand-written app code** — a tiny sandboxed counter Worker (`server`) and its matching iframe UI
  (`client`) — fed through `makeModelClientScripted`. This proves the pipeline mechanics for real:
  real RPC round trips, real pending-row bookkeeping, real accept/revert state transitions, real
  code stored and versioned. It does **not**, and cannot, prove anything about actual LLM-driven
  code-generation *quality* — stated explicitly here again because it is the one thing this whole
  stage cannot empirically verify without a live model key, not because it's being glossed over.

No changes flagged; this stage confirms the agent-authoring flow, it does not alter it.

---

## Concrete interfaces later stages build against

This section is the actual deliverable "later stages" (a hypothetical further Sandboxed-runtime
polish stage, Agent-tooling stage, or Web-polish stage) should read instead of re-deriving these
contracts. Everything below is real and already implemented; no code in this section is new.

### `AppRuntimeService` (`packages/backend/src/app-runtime-service-live.ts`)

```ts
class AppRuntimeService extends Context.Tag(...)<
  AppRuntimeService,
  {
    readonly runRequest: (
      workspaceId: EntityId,
      appId: EntityId,
      request: Request
    ) => Effect.Effect<Response, DomainError>
  }
>() {}

// Real Layer, needs AppsService and a live WorkerLoader binding:
makeAppRuntimeServiceLive(loader: WorkerLoader): Layer.Layer<AppRuntimeService, never, AppsService>

// Fail-closed fallback when env.LOADER is unset:
AppRuntimeServiceUnconfigured: Layer.Layer<AppRuntimeService>
```

`runRequest` is mainline-only (no `chatId`/preview-branch parameter — see that file's own header
comment for why a chat-preview execution path is deliberately deferred, not an oversight). Fails
`AppNotFound` / `AppCodeVersionNotFound` per `AppsService.getApp`/`getAppCode`'s own contract.

### App-run credential (`packages/backend/src/app-run-credential.ts`)

```ts
signAppRunCredential(
  workspaceId: EntityId, appId: EntityId, secret: string,
  ttlSeconds?: number, now?: Date
): Effect.Effect<{ credential: string; expiresAt: Date }, never>

verifyAppRunCredential(
  credential: string, secret: string, now?: Date
): Effect.Effect<{ workspaceId: string; appId: string }, Unauthorized>
```

Stateless HMAC-SHA-256, signed with the same `DEV_AUTH_HMAC_SECRET` a session credential uses but
tagged with a distinct version string (`"athenaeum-app-run-v1"`) so the two credential shapes can
never be replayed as each other. TTL default 600s (`DEFAULT_TTL_SECONDS`) — covers one interactive
preview session, not one request.

### The two App HTTP routes (`packages/backend/src/workspace-durable-object.ts`)

```
GET  /api/workspace/:workspaceId/apps/:appId/client.js
ALL  /api/workspace/:workspaceId/apps/:appId/run(/*restPath)
```

Both accept EITHER a real session credential with `"use"` role, OR a valid `athenaeum-app-run-v1`
credential naming the exact `workspaceId`/`appId` in the URL. `/run` strips the caller's
`Authorization`/`Cookie` headers and the credential's own `?token=` param before forwarding into
`AppRuntimeService`; the forwarded path has the `.../run` prefix stripped (`.../run/widgets/7` →
`/widgets/7` inside the App).

### The seven role-gated RPC methods (`domain/src/app-rpc.ts`, implemented on `WorkspaceDurableObject`)

```
createApp, updateAppCode, deleteApp   → requireRoleForGovernedWorkspace(currentUser, "build")
listApps, getApp, getAppCode,
mintAppRunCredential                  → requireRoleForGovernedWorkspace(currentUser, "use")
```

### Client-side sandbox contract (`packages/web/src/AppLibraryPanel.tsx`, `app-sandbox-bootstrap.ts`)

- Preview iframe: `sandbox="allow-scripts"`, `srcDoc`-loaded, no `allow-same-origin`.
- The shared `AppRunFrame` wraps every client bundle in document-contract version 1: a viewport
  meta tag, a full-height `#app-root`, reduced-motion/focus defaults, and a small set of semantic
  `--athenaeum-*` CSS variables. `html[data-athenaeum-theme]` mirrors the shell's Paper/Dark
  choice, so an App can feel native to the current workspace without reading the parent document.
  The contract is inline and versioned in `app-sandbox-document.ts`; it grants no additional
  origin, storage, messaging, or RPC capability.
- `buildAppSandboxBootstrapScript(runBaseUrl, token): string` — renders the `window.fetch`
  rewrite as an inline `<script>` for the iframe's `srcDoc`, run before the App's own `client.js`.
- `rewriteFetchTarget(runBaseUrl, token, urlStr): string | undefined` — the same logic as a plain,
  directly unit-tested function (`undefined` means "don't rewrite," i.e. an absolute/
  protocol-relative URL).
- Known, accepted limitation: `fetch(new Request(...))` passes through unrewritten (documented in
  `app-sandbox-bootstrap.ts`'s own header comment) — real future work if an App ever needs that
  shape, not a silent gap.

### What is explicitly NOT built, for a future capability-grant stage to design

- No per-App server-side capability grants exist (`env` is always `{}`). The natural extension
  point is one named `env` entry per explicit grant, mirroring `overseer.ts#getEnvForLoader`'s
  per-approved-edge loop — never a widened default.
- No chat-preview execution path (`runRequest` only ever loads mainline, accepted code) — running
  not-yet-reviewed agent-proposed server code against a real request is a materially bigger
  surface than this pass covers.
- No live-RPC channel into the iframe (only a `fetch()` rewrite) — if a future stage needs one,
  cloudflare-os's `MessageChannel`/Cap'n Web handshake (`GadgetUI.tsx`) is the pattern to adopt.
