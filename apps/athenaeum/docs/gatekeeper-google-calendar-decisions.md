# `gatekeeper-google-calendar` design decisions

Status: Phase 5 pre-work stage (client + observer-verification design), **complete**; Phase 5
domain-extension stage (`CalendarEvent`/`Bookmark`/`GatekeeperBinding`/gatekeeper-rpc schemas),
**complete**; Phase 5 real-build stage (this section — the real `GatekeeperAccountDurableObject`
Worker, `athenaeum-router`'s `GATEKEEPER_*` wiring, and `athenaeum-backend`'s `CalendarService` +
the eight gatekeeper-rpc.ts RPC methods), **complete, see "§3 — Real build" below**. Package:
`packages/gatekeeper-google-calendar` (its own Cloudflare Worker, per the plan's
one-Worker-per-gatekeeper deployment topology — now genuinely wired to `packages/router` and
`packages/backend`, see §3).

Sources read in full before designing anything, per this stage's own instructions:
`/Users/rawkode/.claude/plans/i-ve-tried-to-build-proud-thacker.md`'s "Agent-native editing &
gatekeeper integrations" section (the `gatekeeper-google-calendar` and observer-strategy
paragraphs) and "Google Calendar provider projection" (via `new-notes/docs/architecture.md`,
cited there); `cloudflare-os/docs/observers.md` in full; `cloudflare-os/packages/gatekeeper-google/
src/calendar-api.ts` + `calendar-types.d.ts` (behavior only, not code — different RPC/Effect
stack); `cloudflare-os/packages/workshop-shared/src/gatekeeper.ts` in full (the committed
`GatekeeperVendor`/`GatekeeperUser`/`Gatekeeper<Session>`/`GatekeeperUserVerifier` interfaces);
Phases 0–4's real code (`packages/domain`, `packages/typed-storage-effect`, `packages/backend`,
specifically `sharing.ts`/`sharing-service-live.ts`/`auth.ts`/`dev-auth.ts`/`workspace-durable-
object.ts`'s `requireRoleForGovernedWorkspace`, and `model-client-anthropic.ts` as the literal
"HTTP-layer-mocked Layer" template this stage's client tests follow).

---

## 1. Pluggable Google Calendar API client design

### The interface

`GoogleCalendarClient` (`packages/gatekeeper-google-calendar/src/google-calendar-client.ts`) is a
`Context.Tag` covering exactly the task's list — OAuth authorization-URL construction,
authorization-code-for-tokens exchange, refresh-token flow, `events.list`, single-event CRUD —
plus two methods `observer-verification.ts` needs (`listCalendars`/`getCalendar` for Strategy B,
`freeBusy` for Strategy C):

```ts
buildAuthorizationUrl(options): Effect<{url}, GoogleCalendarClientError>
exchangeAuthorizationCode(code, redirectUri): Effect<OAuthTokens, GoogleCalendarClientError>
refreshAccessToken(refreshToken): Effect<OAuthTokens, GoogleCalendarClientError>
listEvents(accessToken, calendarId, query: CalendarEventsListQuery): Effect<CalendarEventsPage, GoogleCalendarClientError>
getEvent / createEvent / updateEvent / deleteEvent(accessToken, calendarId, ...): Effect<..., GoogleCalendarClientError>
listCalendars(accessToken): Effect<GoogleCalendarInfo[], GoogleCalendarClientError>
getCalendar(accessToken, calendarId): Effect<GoogleCalendarInfo, GoogleCalendarClientError>
freeBusy(accessToken, calendarIds, timeMin, timeMax): Effect<PersonAvailability[], GoogleCalendarClientError>
```

Same split as `@athenaeum/domain`'s `ModelClient`: an interface file with zero HTTP/env
dependencies, two real `Layer` implementations in sibling files. **Deliberately local to this
package, not `@athenaeum/domain`** — the plan's own "reuse the interface contracts... as the
target shape for `domain`'s own `gatekeeper.ts`" instruction is about the cross-cutting
`GatekeeperVendor`/`GatekeeperUser`/`Gatekeeper<Session>` three-tier RPC contract every future
gatekeeper package will implement (still not built — see "What this stage does not build" below);
`GoogleCalendarClient` is one gatekeeper's own internal HTTP-abstraction seam, the same
architectural layer as `ModelClientAnthropic`'s `HttpFetch`, which likewise lives in `backend`,
not `domain`. Nothing about `GoogleCalendarClient` needs to be visible outside this package.

`GoogleCalendarClientError` is a closed five-variant union (`errors.ts`), same discipline as
`ModelError`: `GoogleCalendarNotConfigured` (no OAuth credential — this task's hard-constraint
case), `GoogleCalendarRequestFailed` (network/non-2xx), `GoogleCalendarResponseInvalid` (bad
shape), `GoogleCalendarAuthFailed` (a categorized OAuth token-endpoint error —
`reason: "invalidGrant" | "policyBlocked" | "other"`, mirroring `cloudflare-os/google-api.ts`'s own
`RefreshFailure` categorization, generalized to code-exchange too), and
`GoogleCalendarSyncTokenExpired` (Google's documented 410 response, its own tag because it has a
distinct, expected remediation — see "Pagination discipline" below — not a generic failure).

### Shapes verified against Google's real, current docs (this stage — not guessed)

Fetched live and cross-checked against `cloudflare-os/gatekeeper-google`'s own implementation
(which independently corroborates every shape below, though it was read for behavior only):

- **OAuth2 web-server flow** (`https://developers.google.com/identity/protocols/oauth2/web-
  server`): authorization endpoint `https://accounts.google.com/o/oauth2/v2/auth` with
  `client_id`/`redirect_uri`/`response_type=code`/`scope`/`access_type`/`state`/`prompt`; token
  endpoint `https://oauth2.googleapis.com/token`, `POST` form-encoded,
  `grant_type=authorization_code` (fields `code`/`client_id`/`client_secret`/`redirect_uri`) or
  `grant_type=refresh_token` (fields `client_id`/`client_secret`/`refresh_token`); response
  `{access_token, expires_in, refresh_token?, scope, token_type}` — confirmed `refresh_token` is
  **only present on the first exchange with `access_type=offline`**, never on a refresh-grant
  response (this client's `OAuthTokens.refreshToken` is `optional`, and `refreshAccessToken`'s own
  doc comment states it is always absent on that path — verified by test).
- **`events.list`** (`https://developers.google.com/calendar/api/v3/reference/events/list`): the
  exact mutual-exclusivity rule between `syncToken` and `timeMin`/`timeMax`/`showDeleted`/
  `orderBy`/`updatedMin`/`q`/extended-property filters — **`singleEvents` is NOT in that restricted
  list**, confirmed live (a detail easy to get wrong by assumption, and worth stating explicitly:
  incremental syncToken requests still need `singleEvents=true` to keep recurring-event expansion
  consistent with the initial window sync). 410 Gone is documented for an expired `syncToken`.
- **Event resource** (`https://developers.google.com/calendar/api/v3/reference/events`):
  `id`/`status`/`summary`/`description`/`location`/`start`&`end` (`{dateTime|date, timeZone}`)/
  `attendees` (`email`/`displayName`/`optional`/`responseStatus`/`organizer`/`self`)/`reminders`/
  `htmlLink`/`transparency`/`visibility`/`recurringEventId` — `events.insert`/`events.patch` use
  the identical resource shape for request and response; `sendUpdates` accepts
  `all`/`externalOnly`/`none` on insert/patch/delete.
- **`freebusy.query`** (`https://developers.google.com/calendar/api/v3/reference/freebusy/query`):
  request `{timeMin, timeMax, timeZone?, items:[{id}]}`; response
  `{calendars: {[id]: {busy:[{start,end}], errors?:[{domain,reason}]}}}`, documented reasons
  include `notFound` — exactly Strategy C's access oracle (§2 below).

### Pagination discipline: page-at-a-time, not auto-looped

**A deliberate departure from `cloudflare-os/gatekeeper-google`'s own `GoogleCalendarApi
#listEvents`**, which loops internally and returns a fully-materialized array. This client's
`listEvents` returns exactly **one page** per call. The task's own citation — new-notes'
`docs/architecture.md` §"Google Calendar provider projection" — is the reason: "One SQLite
transaction applies a page's provider-managed structured records and its next checkpoint... A
crash before that cross-object commit resumes the immutable range before fetching another page."
That per-page transactional checkpoint is impossible if the client already consumed every page
internally before returning. `CalendarEventsListQuery` is a discriminated union
(`{mode:"window", timeMin, timeMax, singleEvents, showDeleted, pageToken?, maxResults?}` |
`{mode:"syncToken", syncToken, singleEvents, pageToken?}`) so Google's real mutual-exclusivity
restriction is enforced by TypeScript itself, not by runtime validation — the caller cannot
construct the illegal combination. `listCalendars`, by contrast, auto-paginates internally up to a
bounded cap (250): it is a bounded, user-facing picker list, not an incrementally-synced dataset,
so there is no per-page checkpoint to preserve.

`GoogleCalendarSyncTokenExpired` is surfaced as its own error, but **this client does not itself
implement new-notes' cited remediation** ("clears its storage, installs a fresh one-month-past/
six-month-future window, and retries once") — that is calendar-merge's own storage/retry policy,
deliberately kept out of a thin API client (see `google-calendar-client.ts`'s own doc comment on
`listEvents`).

### What this client does NOT do (deliberate scope lines)

- **No implicit token refresh.** Every method takes `accessToken` as a plain argument; a 401 is
  surfaced as `GoogleCalendarRequestFailed`, never auto-retried with a refreshed token (unlike
  `cloudflare-os`'s `fetchWithAuthRetry`'s one-shot 401 retry). Token-lifecycle policy (when to
  refresh, how to cache) belongs to whatever owns the OAuth connection's storage — not built this
  stage (see §2's "What the next stage builds" for exactly what that storage needs to be).
- **No `state`/CSRF-nonce minting or verification.** `buildAuthorizationUrl` takes `state` as a
  caller-supplied opaque string and round-trips it verbatim — generating and verifying it is the
  OAuth-flow orchestrator's job (mirrors `cloudflare-os/google.ts`'s own `generateNonce()`, which
  likewise lives outside `GoogleCalendarApi`).
- **No calendar-merge/attendee-import logic.** This is a client, not the gatekeeper.

### The two Layers

**`GoogleCalendarClientScripted`** (`google-calendar-client-scripted.ts`) — same factory-per-test
shape as `model-client-scripted.ts` (never a module-level mutable queue). Fixtures model a small
multiverse of Google accounts (`accessToken` is treated as an opaque fixture-account key, never a
real token), each with its own `calendars: {id -> accessRole}`, `freeBusyReadableCalendarIds`, and
`events`. This is exactly the shape `observer-verification.test.ts` needs: "this observer's own
account has writer access to calendar X" and "this observer's own account cannot read calendar Y's
free/busy at all" are both just different scripted accounts, no special-casing needed.

**`GoogleCalendarClientReal`** (`google-calendar-client-real.ts`) — a real HTTP client, reading
`clientId`/`clientSecret` from `GoogleCalendarClientRealConfig` (both `string | undefined`,
**genuinely unset in this environment — no credential is fabricated**). Every method that needs a
credential calls `requireCredentials()` first, failing `GoogleCalendarNotConfigured` before any
network I/O — proved by test (`mock.calls` asserted empty). The one seam it reaches the network
through is `HttpFetch` (`http-fetch.ts`), the **same pattern, same name, same rationale** as
`model-client-anthropic.ts`'s own `HttpFetch` — deliberately not `@effect/platform`'s `HttpClient`
for the identical reason that file states (no existing dependency, not worth pulling in for one
outbound call). `test/google-calendar-client-real.test.ts` mocks **only** `HttpFetch` — 33 tests,
all passing, covering: unconfigured fail-closed behavior, authorization-URL construction (every
required param, `prompt=consent` only when `forceConsent`), code exchange and refresh (exact
form-encoded body, `invalid_grant`/`admin_policy_enforced` categorization), `events.list` in both
query modes (asserting the FORBIDDEN params are genuinely absent from the request in each mode,
not just that the allowed ones are present), all-day vs. timed event decoding, the 410→
`GoogleCalendarSyncTokenExpired` mapping, single-event CRUD (field-level PATCH semantics), and
`freeBusy` (including the "calendar absent from response entirely" → `notFound` case).

### Enabling this for real — what David would need to register in Google Cloud Console

1. A Google Cloud project with the **Calendar API enabled** (APIs & Services → Library → "Google
   Calendar API" → Enable).
2. An **OAuth 2.0 Client ID** (APIs & Services → Credentials → Create Credentials → OAuth client
   ID → Web application) → `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
3. An **OAuth consent screen** with at least `https://www.googleapis.com/auth/calendar` (or
   `.../calendar.readonly` for a read-only binding), plus
   `.../calendar.calendarlist.readonly` if the calendar-picker flow (`listCalendars`) is exposed
   at connect time.
4. This Worker's real deployed callback URL added to the client's **Authorized redirect URIs**,
   byte-for-byte (Google's own documented requirement — "case, and trailing slash must all
   match") — e.g. `https://<router-host>/gatekeeper/google-calendar/oauth/callback`, matching
   whatever route the next stage's OAuth-flow HTTP handler actually serves it on (not built this
   stage — see below).
5. `wrangler secret put GOOGLE_OAUTH_CLIENT_ID` / `wrangler secret put
   GOOGLE_OAUTH_CLIENT_SECRET` on the real deployment — **never** plaintext `vars` (unlike
   `athenaeum-backend`'s dev-only `DEV_AUTH_HMAC_SECRET` carve-out: these are real third-party
   credentials with no local-dev equivalent, so there is no dev/prod split to make — either
   they're configured for real, or every credentialed method fails closed).

**A real live-API integration test is explicitly not possible in this environment** — no step
above can be completed here. Everything this stage could verify without one, it did (request/
response shape correctness via the WebFetch-sourced doc citations above, proved against the real
client code via HTTP-layer-mocked tests).

---

## 2. Observer strategy B/C design

`docs/observers.md` (read in full) is the literal spec. §9.1's decision table assigns Google
Calendar exactly what the task states: **selected-calendar binding → Strategy B**; `allVisible`-
availability binding → **Strategy C**. Both are implemented as real, tested Effect programs in
`observer-verification.ts`, against `GoogleCalendarClient` + `ObserverLedger`.

### Strategy B (`verifyObserverStrategyB`)

"The resource is treated as one atomic unit... No `excludeObservers` is needed: the whole unit is
covered up front" (`docs/observers.md` §9.1). Implementation: `getCalendar(observerAccessToken,
calendarId)` — the observer's OWN account's `accessRole` on the bound calendar — must be `writer`
or `owner`; `reader` (or no access at all, surfaced as a request failure) fails with
`ObserverVerificationFailed`, per the task's own wording: "reader access hides private-event
details, so reader-only doesn't qualify." `getCalendar` (not `listCalendars`) is the right
primitive — it targets exactly the one bound calendar. Tested against three scripted accounts
(writer/owner-equivalent, reader-only, no-access-at-all) — all three pass/fail as expected.

### Strategy C (`addObserverStrategyC` / `onDatasetTouched` / `removeObserverStrategyC`)

"The Gatekeeper DO maintains its own log of the data sets it has actually observed... `addObserver
()` verifies the observer against EVERY logged set so far. When a later observation first touches
a NEW set, the gatekeeper re-verifies all current observers and sets `excludeObservers` for any
who fail" (`docs/observers.md` §9.1). Three real, tested pieces:

- **`ObserverLedger`** (`observer-ledger.ts`) — per-binding storage for (a) which foreign calendar
  ids have ever been touched (the dataset log) and (b) which observers are currently registered
  (needed for re-verification-on-every-open AND for the "re-verify everyone when a new set is
  touched" sweep). `recordDatasetTouch` is idempotent and reports `newlyTouched` — the caller's
  signal for whether a re-verification sweep is needed at all. `removeObserver` is idempotent, per
  `gatekeeper.ts`'s own documented contract for `Gatekeeper.removeObserver()`.
- **`addObserverStrategyC(bindingId, observerId, identity, observerAccessToken)`** — the
  `addObserver`-time half: verifies the observer against every calendar the ledger already logs
  (via `freeBusy`, not `getCalendar` — see the code's own doc comment: an `allVisible` binding's
  whole point is calendars the CONNECTED account may only have `freeBusyReader`-level visibility
  into, which `calendarList`/`getCalendar` would reject but `freeBusy` correctly allows), and only
  persists the registration if every check passes — a partially-verified observer is never stored.
- **`onDatasetTouched(bindingId, calendarId, resolveAccessToken)`** — the "a new observation just
  read a calendar we've never logged" half. Records the touch; if it was genuinely new, re-
  verifies every CURRENTLY REGISTERED observer against that one calendar and returns
  `failedObserverIds`. Deliberately returns the list rather than acting on it — see "What
  Athenaeum does not have yet" below.

Tested (`observer-verification.test.ts`, 12 cases) against `ObserverLedgerInMemory`, a real (not
mocked) `Ref`-backed `Layer` — "Layer-based DI lets business-logic services swap real storage for
an in-memory `Layer.succeed` double in plain Vitest, without workerd" (the plan's own "Testing
payoff" paragraph): registering with no prior touches, re-verification against multiple already-
logged calendars (one observer passes both, another fails on exactly one), the "second touch of an
already-logged calendar never re-verifies anyone" no-op case, and the core "one observer keeps
access to a newly-touched calendar, another loses it — only the second is reported" scenario.

### The opaque `GatekeeperUserVerifier`-minting mechanism, adapted to Athenaeum

cloudflare-os's pattern (`gatekeeper.ts`, read in full): the prospective observer's **own**
`GatekeeperUser` (a `Fetcher` on a separate, per-vendor `UserAccount` Durable Object) mints an
opaque `GatekeeperUserVerifier`; the overseer hands it to the target gatekeeper, which "unwraps"
it via a non-standard method only that gatekeeper's own verifier implementation defines — a
capability-opacity trick that works because there IS a separate `GatekeeperUser` object per
connected account, reachable as an RPC `Fetcher`.

**Athenaeum has no such object.** Phase 4 built `AuthenticatedUser`/`SharingService` (an Athenaeum-
account identity + permission graph) but deliberately shipped **zero** "connected external
account" concept — Phase 4's own scope was "no observers yet... no external-service data exists to
leak until Phase 5." This stage is where that concept has to be invented for Athenaeum, not
borrowed unchanged.

**The adaptation** (`observer-verifier.ts`): since this gatekeeper Worker will be the sole owner of
"which Google account did observer X connect" storage — there is no separate User DO in this
design to delegate that to (see "Why the verifier is minted inside this Worker" below) — minting
naturally becomes something THIS gatekeeper does on the observer's own behalf, once it has
verified (via Athenaeum's own `AuthenticatedUser`/dev-auth bearer credential — the SAME mechanism
`workspace-durable-object.ts`'s `requireRoleForGovernedWorkspace` already gates every mutating/reading RPC
method on, per this task's hard constraint) that the caller genuinely IS that observer. The opacity
property cloudflare-os's design protects — the workspace/sharing layer that shuttles a verifier around
can never read the observer's Google identity out of it — is preserved by making the token itself
an HMAC-signed, self-verifying opaque blob:

```ts
class ObserverIdentity { observerEmail: Email; connectionId: string }  // what a verifier proves, once unwrapped
class GatekeeperUserVerifier { token: string }                          // the opaque envelope

mintGatekeeperUserVerifier(identity, secret, ttlSeconds, now?): Effect<GatekeeperUserVerifier, never>
unwrapGatekeeperUserVerifier(verifier, secret, now?): Effect<ObserverIdentity, VerifierUnwrapFailed>
```

**This directly reuses `@athenaeum/backend`'s own `dev-auth.ts` HMAC discipline**
(`crypto.subtle.importKey("raw", ..., {name:"HMAC", hash:"SHA-256"}, false, [usage])`,
`base64url(payload).base64url(signature)`, fail-closed-never-leak-why-verification) rather than
inventing a new one — a deliberate continuity choice, proved by test: mint→unwrap round-trips the
identity; the token string contains neither the email nor the connection id in plaintext (genuine
opacity, not just "the type system says it's opaque"); a token signed with the wrong secret is
rejected; an expired token is rejected.

`connectionId` is deliberately opaque OUTSIDE this package (a key into per-observer connected-
account storage), never the access token itself or a Google identifier — a verifier is minted once
and re-verified many times across a token's natural refresh cycle ("`addObserver()` may be called
again with the same user ID... The overseer may run this periodically", `gatekeeper.ts`'s own
doc comment), so it must reference the connection, not a point-in-time credential.

**Why the verifier is minted inside this Worker, not a separate User DO:** cloudflare-os's
`Overseer`/`UserAccount`-DO split exists because ONE Overseer coordinates MANY different vendors'
gatekeepers, so connected-account storage has to live somewhere vendor-agnostic. Athenaeum's
architecture (plan §"Repo/package layout") has no Overseer-equivalent shared across gatekeepers —
each gatekeeper is its own independent Worker (`packages/router`'s dumb path-prefix design,
`Rel(router, gkCalendar, "Service binding")`). A per-vendor connected-account store living inside
that vendor's own gatekeeper Worker is the natural placement, not a deviation forced by expediency.
**This IS a genuinely different trust boundary than cloudflare-os's** (same-Worker HMAC opacity vs.
cross-Worker `Fetcher` capability opacity) — stated explicitly, not glossed over. Once this
gatekeeper is wired to `WorkspaceDurableObject` over a real Cap'n Web service-binding boundary (next
stage), the SAME opaque token becomes the payload a real `Fetcher<GatekeeperUserVerifier>` stub
carries across THAT boundary — the token format does not need to change, only its transport.

### What Athenaeum does not have yet (the honest gap `onDatasetTouched` leaves)

`onDatasetTouched` returns `failedObserverIds` rather than acting on them, because Athenaeum has no
`ObservationDescription.excludeObservers`/`ApprovalQueue` equivalent to hand them to.
`AgentEditService`'s `changes`/`pending` stream (the nearest analog) has no per-observer visibility
gate at all — it is a chat-scoped accept/revert mechanism, not an observation-authorization
mechanism. Concretely: cloudflare-os's `authorizeObservation()` (`gatekeeper.ts`'s
`ApprovalQueue extends ObservationAuthorizer`) runs on EVERY read through a gatekeeper, before data
returns to the caller, and can block an individual observation or exclude named observers from
seeing it. Athenaeum's sharing model has nothing that runs per-read at all — `SharingService`'s
`requireMinimumRole` (§`workspace-durable-object.ts`) gates whole RPC METHODS, not individual pieces of
data a method's response contains. Building that — deciding what "this one piece of calendar data
must not be visible to observer X, even though they can call the method" means for Athenaeum's
architecture — is real, non-trivial design work the next stage owns, not something to improvise
here by bolting a mechanism onto the wrong layer.

---

## What the next stage builds against

**Client (§1):**
- Depend on `GoogleCalendarClient` via `Context.Tag`, exactly like every other repository/service.
- Tests: `makeGoogleCalendarClientScripted({...}).layer` — no network, real coverage.
- Production: `makeGoogleCalendarClientRealLive({clientId: env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET})` layered over `HttpFetchLive`, once `Env` gains
  those two bindings (real secrets, per the Google Cloud Console steps above) and this package's
  future OAuth-flow HTTP handler / calendar-merge DO wires it in.
- Build the OAuth-flow HTTP handler (`GET /oauth/authorize`, `GET /oauth/callback`) this package's
  `worker.ts` does not yet have — `buildAuthorizationUrl`/`exchangeAuthorizationCode` are ready to
  be called from it.
- Build the actual pagination/checkpoint loop new-notes' cited pattern describes, driving
  `listEvents` page-at-a-time with the per-page SQLite-transaction discipline described in §1.

**Observer verification (§2):**
- A real `GatekeeperGoogleCalendarBindingDurableObject` (or equivalent), one per
  `gatekeeperBindings` row, composing: this package's `GoogleCalendarClient` Layer, a REAL
  `ObserverLedger` via `makeObserverLedgerCollections(this.ctx.storage)` +
  `makeObserverLedgerTypedStorageLive(...)` (already built, real `typed-storage-effect` code —
  the one piece of this stage explicitly not covered by a `vitest-pool-workers` test; that
  integration test is this next stage's first job), and the per-observer connected-account
  storage `ObserverIdentity.connectionId` references (not built this stage at all — needs its own
  small collection: `{connectionId, observerEmail, refreshToken, ...}`, keyed however this
  gatekeeper chooses, mirroring `cloudflare-os/google.ts`'s `UserAccount` DO's storage shape
  behaviorally, not literally).
- An `AccessTokenResolver` (the `(identity: ObserverIdentity) => Effect<string, ...>` this stage's
  `onDatasetTouched`/`addObserverStrategyC` already take as a parameter) implemented against that
  new connected-account storage, handling refresh-on-expiry via `GoogleCalendarClient
  .refreshAccessToken` (§1's client already supports this; nothing new to build there).
- A real, callable `addObserver(observerId, verifier: GatekeeperUserVerifier)`/
  `removeObserver(observerId)` RPC surface — this stage's `verifyObserverStrategyB`/
  `addObserverStrategyC`/`removeObserverStrategyC` are the bodies those methods call, already
  unwrapping a `GatekeeperUserVerifier` via `unwrapGatekeeperUserVerifier` first.
- The real cross-Worker wiring (`WorkspaceDurableObject` → this Worker via service binding,
  `packages/router`'s `GATEKEEPER_*` binding-discovery loop reintroduced) — this stage's
  `wrangler.jsonc` deliberately does not attempt this; see that file's header comment.
- The design decision flagged above ("What Athenaeum does not have yet") — what `onDatasetTouched`'s
  `failedObserverIds` should actually DO once Athenaeum has an observation-authorization concept to
  hand them to.

---

## §3 — Real build: the Worker, router wiring, and `CalendarService`

Everything the previous two sections listed as "what the next stage builds" is now real, tested
code (reading done first, per this stage's own instructions: this doc in full, the plan's
"Agent-native editing & gatekeeper integrations" section again, `cloudflare-os/docs/observers.md`
again for the exact `addObserver`/`removeObserver`/`getVerifier` contract wording, `cloudflare-os/
packages/gatekeeper-google/src/calendar-api.ts`+`calendar-types.d.ts` again for behavior, Phases
0–4's real code — `domain`, `typed-storage-effect`, `backend`, especially `workspace-durable-
object.ts`'s full `requireRoleForGovernedWorkspace` gate and every existing RPC method's shape,
`router/src/index.ts`, and `model-client-anthropic.ts` as the HTTP-mocked-Layer template).

### 3.1 The "GatekeeperUser" adaptation, concretely

Per this stage's own brief: since Athenaeum isn't a Dynamic-Worker-Facet architecture, "a DO per
connected account holding the OAuth tokens, exposing calendar operations as RPC methods the main
backend Worker's `WorkspaceDurableObject` calls via a service binding" — built exactly as specified:

- **`GatekeeperAccountDurableObject`** (`gatekeeper-google-calendar/src/gatekeeper-account-
  durable-object.ts`) — one instance per connected Google account, `ctx.id.name === email`
  (mirrors `UserDurableObject`'s own `idFromName(email)` addressing). Thin DO-class shell (per
  `WorkspaceDurableObject`'s own "DO class boundary" pattern) around **`GatekeeperAccountService`**
  (`gatekeeper-account-service.ts`/`-service-live.ts`), a real Effect Service — testable with
  plain Vitest + in-memory `Layer`s, zero `workerd` dependency, same "Testing payoff" every other
  service in this codebase gets. Owns: OAuth token lifecycle (`TokenStore`, real
  `typed-storage-effect` Singleton in production, `Ref`-backed in tests), refresh-on-401 retry
  (`withAccessTokenRetry` — deliberately NOT built into `GoogleCalendarClientReal` itself, per
  that file's own documented scope line keeping token policy out of the thin client), and the
  `getVerifier`/`addObserver`/`removeObserver`/`onCalendarTouched` observer-verification surface,
  wired directly onto §2's already-built `verifyObserverStrategyB`/`addObserverStrategyC`/
  `removeObserverStrategyC`/`onDatasetTouched`.
- **Cross-DO observer resolution**: `addObserver`/`onCalendarTouched` (called on the BINDING
  OWNER's account DO) resolve the OBSERVER's own live access token by addressing the observer's
  own `GatekeeperAccountDurableObject` instance directly — `this.ctx.exports
  .GatekeeperAccountDurableObject.getByName(identity.connectionId).getAccessTokenForVerification()`
  — same-Worker native RPC, never exposed over the Worker's own HTTP surface (see
  `getAccessTokenForVerification`'s own doc comment: "never returns the access token to an
  external HTTP caller").
- **No Cap'n Web on this DO** — deliberate, documented in `gatekeeper-account-durable-
  object.ts`'s and `rpc-boundary.ts`'s own header comments: this DO has no external client (a
  browser never opens a session on it); it's reached by `worker.ts` (same-Worker `ctx.exports`)
  and by a sibling DO (also same-Worker `ctx.exports`). Cap'n Web's object-capability machinery
  (live stubs, promise pipelining) has no use case on either boundary. This is a deliberate
  simplification of the task's literal "Effect + capnweb" scaffold description — `capnweb` is not
  a dependency of this package's production code at all (checked: only `effect` +
  `@athenaeum/typed-storage-effect`), and the RpcErrorEnvelope discipline the task DOES ask for is
  still real: a package-local `{tag, message}` envelope (`rpc-boundary.ts`), same wire shape and
  same "flatten any Cause, never leak an opaque FiberFailure" discipline as `athenaeum-backend`'s
  own `rpc-boundary.ts`, just crossing a plain-thrown-`Error`/plain-JSON boundary instead of a
  Cap'n Web one.
- **`worker.ts`** — the real `GatekeeperVendor` surface: `GET .../describe` (`describe()` +
  `getSupportedResources()`, folded into one response), `POST .../connect` (`connectAccount()` —
  starts a REAL OAuth flow: builds the real Google authorization URL via a throwaway
  `GoogleCalendarClientReal`, using the caller-supplied `state`/`redirectUri` per
  `AuthorizationUrlOptions`'s own "the caller's job to mint/verify state" contract), and
  `/account/:email/<op>` — one route per `GatekeeperAccountDurableObject` method, dispatched by
  name, JSON in/out.

### 3.2 Cross-Worker call shape: `athenaeum-backend` ↔ this Worker

**Plain JSON-over-`Fetcher.fetch()` service binding, not Cap'n Web** (`calendar-gatekeeper-
client.ts`'s and `rpc-boundary.ts`'s own header comments carry the full reasoning — restated
briefly): the plan's `Rel(workspaceDo, gkCalendar, "startSession() via Facet...")` relationship,
adapted, since Athenaeum has no Dynamic-Worker-Facet architecture for `startSession()` to hand
back a live capability stub from. "The session" is simply "this account's email, addressed
per-call" — a call/response shape with no live-stub need, unlike `WorkspaceDurableObject`'s OWN Cap'n
Web surface (which genuinely needs `subscribeToNodes`'s live subscriptions). Wire types
(`RemoteCalendarEvent`/etc.) are declared LOCALLY in `calendar-gatekeeper-client.ts`, not imported
from the gatekeeper package — `athenaeum-backend`'s PRODUCTION code has zero dependency on any
gatekeeper package (only a devDependency, for wrapping `GoogleCalendarClientScripted` in tests —
see §3.4).

### 3.3 `athenaeum-router`: real `GATEKEEPER_*` discovery

`packages/router/src/index.ts` — confirmed (per this stage's own instruction) that Phase 0 built
only the dumb `/api/*` → backend proxy half, with no `GATEKEEPER_*` scanning at all (its own
header comment said so explicitly). This stage ports `cloudflare-os/packages/router/src/index.ts`'s
scanning loop verbatim: `GATEKEEPER_GOOGLE_CALENDAR` env key → `/gatekeeper/google-calendar/*`
path prefix → that binding's `.fetch()`. `athenaeum-router`'s own `wrangler.jsonc` now declares
that service binding, pointed at `athenaeum-gatekeeper-google-calendar`.

### 3.4 `athenaeum-backend`: `CalendarService` + the eight RPC methods

`calendar-service-live.ts` — a backend-internal Effect Service (same placement rationale as
`GraphService`/`NotesService`: real orchestration logic, no home in `domain`'s zero-CF repository
interfaces), composed into `WorkspaceDurableObject`'s instance Layer exactly like every other service,
backed by three new `typed-storage-effect` collections (`calendar-collections.ts`:
`gatekeeperBindings`, `calendarEvents`, `bookmarks`). All eight `gatekeeper-rpc.ts` methods are
wired onto `WorkspaceRpcApi`, and — per this task's hard constraint, checked against every single one
— **every one calls `requireRoleForGovernedWorkspace`**: mutations (`connectGoogleCalendar`,
`googleCalendarOAuthCallback`, `disconnectGoogleCalendar`, `syncGoogleCalendar`,
`linkCalendarEventToNode`, `createBookmark`) require `"build"`; reads (`listCalendarEvents`,
`listBookmarks`) require `"use"` — exactly the role split `gatekeeper-rpc.ts`'s own header comment
recommended for this stage to implement. Proven by a dedicated test suite section
("governed-workspace role gating") reproducing the exact anonymous-caller-on-a-governed-workspace
scenario the Phase 4 fix pass closed, for these eight methods specifically.

**OAuth flow, concretely**: `connectGoogleCalendar` mints an HMAC-signed `state` token
(`calendar-oauth-state.ts`, reusing `dev-auth.ts`'s exact `crypto.subtle` HMAC discipline a third
time in this codebase) embedding `{workspaceId, boundByEmail}`, asks the gatekeeper Worker to build
the real authorization URL, and returns both to the caller. `googleCalendarOAuthCallback` verifies
`state`, calls the gatekeeper Worker's `exchangeAndConnect` (which completes the real code
exchange against `GatekeeperAccountDurableObject`), and only then creates the `GatekeeperBinding`
row — verify-then-persist, matching this codebase's existing observer-registration discipline.
Both fail closed with a clear `ValidationError` if `CALENDAR_OAUTH_STATE_SECRET`/
`CALENDAR_OAUTH_REDIRECT_URI` are unconfigured (this environment, per the hard constraint) —
every other RPC method is unaffected.

**Calendar sync + attendee import**: `sync()` pages through `events.list` (`singleEvents: true`,
`showDeleted: true`, a bounded ±30/180-day window, up to `MAX_PAGES_PER_SYNC` pages per call — a
documented single-shot simplification of new-notes' own cited checkpointed-per-page-transaction
design, flagged in `calendar-service-live.ts`'s own header comment as what the NEXT stage's real
incremental sync loop should replace) and upserts each event into `calendarEvents`, keyed by
`providerEventId`. **Recurring-event identity**: since `singleEvents: true` never returns the raw
series-master resource (Google's own documented behavior — only expanded instances, each carrying
`recurringEventId`), this stage synthesizes a minimal master row the first time an occurrence of a
new series is seen, giving every occurrence a real, stable `masterRecordId` — a documented,
deliberate simplification of fetching the true master via a separate `events.get(seriesId)` call
(next stage's job; the header comment explains why the synthesized master still satisfies
`calendar-event.ts`'s own stated goal for `masterRecordId`). A cancelled occurrence is upserted
with `status: "cancelled"`, never deleted (tombstone, not removal — proven by the "synthesizing a
stable master row" test, which asserts the cancelled occurrence row exists with the right status).
**Attendee-to-Person-node import**: for each attendee, `FactsRepository` is scanned once per
`sync()` call for an `"email"` predicate matching the address (dedup, per the task's own
wording); a hit reuses the existing node id, a miss creates a `Person`-tagged node
(`BaseTagIds.Person`, via `GraphService.assignTag`) plus the `"email"` Fact, and both the scan
result and every newly-created node are cached for the REST of that same `sync()` pass — proven by
the "imports attendees as deduplicated Person nodes, shared across overlapping events" and
"re-syncing does not duplicate... Person nodes" tests, using a fixture with two events/three
event-rows sharing two attendees.

### 3.5 Testing (task item 5, in full)

- **OAuth flow correctness, mocked-HTTP** (`gatekeeper-google-calendar/test/gatekeeper-account-
  service.test.ts`, new this stage, 8 tests): auth-URL/code-exchange request shape against a real
  `GoogleCalendarClientReal` + faked `fetch` (same "mock only the HTTP call" discipline as
  `model-client-anthropic.test.ts`); refresh-token persistence across a second exchange omitting
  one; and **refresh-token-on-401 retry**, asserted at the HTTP-call level (first `Authorization:
  Bearer <expired>` gets a scripted 401, the SECOND real request carries the refreshed token, and
  a THIRD call is never made — proven via a request-log assertion, not just a passing return
  value) plus its negative case (a persistent 401 surfaces as a real failure, not an infinite
  retry loop).
- **Calendar CRUD + attendee-import, `GoogleCalendarClientScripted`** (`backend/test/calendar-
  service.test.ts`, new this stage, 8 tests, run over REAL Cap'n Web RPC against a REAL
  `WorkspaceDurableObject`): connect/callback/disconnect round trip, cross-workspace `state` rejection,
  the recurring-series/cancelled-occurrence/overlapping-attendees fixture described in §3.4,
  re-sync idempotency + linked-node preservation, bookmarks, and governed-workspace role gating.
  `calendarGatekeeperClientTestHook` (in `workspace-durable-object.ts`, exported alongside — and
  built identically to — the pre-existing `agentEditModelClientTestHook`) is the ONE seam swapped:
  a `CalendarGatekeeperClientApi` wrapping `@athenaeum/gatekeeper-google-calendar`'s own
  `GoogleCalendarClientScripted` double, read live per-call (never captured once at DO-
  construction time), for the identical reason `agentEditModelClientTestHook` needs the same
  discipline (a workspace's DO may already be constructed by an unrelated prior request before a test
  decides what to script).
- **Full suite, real**: `gatekeeper-google-calendar` — `tsc --noEmit` clean, `vitest run` → 41
  tests (33 pre-existing + 8 new). `athenaeum-backend` — `tsc --noEmit` clean, `vitest run` → 133
  tests (125 pre-existing + 8 new), including the full pre-existing suite re-run unchanged
  (constructor changes wired in, zero regressions). `athenaeum-router` — `tsc --noEmit` clean (no
  test suite existed for this package before or after this stage). `domain`/`typed-storage-effect`
  — untouched this stage, re-verified clean (398 + 9 tests) to confirm no incidental breakage.

### 3.6 What a real live test would need, and exactly what to register in Google Cloud Console

Restated from §1 (still accurate, now the actual consuming code exists to point at): **a real
live-API/live-OAuth integration test is not possible in this environment** — no real Google OAuth
client id/secret exists here, and none was fabricated (hard constraint). Every test above proves
request/response SHAPE and business logic against a real, verified-against-Google's-own-docs HTTP
client, mocked only at the `fetch` boundary — never a live network call. To make this real, David
would need to, in Google Cloud Console:

1. Create/select a Google Cloud project and enable the **Google Calendar API** (APIs & Services →
   Library → "Google Calendar API" → Enable).
2. Create an **OAuth 2.0 Client ID** (APIs & Services → Credentials → Create Credentials → OAuth
   client ID → Web application) — this gives `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`.
3. Configure the **OAuth consent screen** with at least `https://www.googleapis.com/auth/calendar`
   (or `.../calendar.readonly` for a read-only binding), plus
   `.../calendar.calendarlist.readonly` (the calendar-picker flow, `listCalendars`).
4. Add this deployment's real gatekeeper-Worker callback URL to the client's **Authorized redirect
   URIs**, byte-for-byte (e.g. `https://<router-host>/gatekeeper/google-calendar/oauth/callback` —
   or, per §3.4's actual flow, the WEB APP's own callback route that calls back into
   `googleCalendarOAuthCallback`, since `state`/callback orchestration lives in `athenaeum-backend`,
   not the gatekeeper Worker itself — see `CalendarServiceApi.connect`'s own doc comment for why).
5. On the real deployment: `wrangler secret put GOOGLE_OAUTH_CLIENT_ID` / `wrangler secret put
   GOOGLE_OAUTH_CLIENT_SECRET` on `athenaeum-gatekeeper-google-calendar`; `wrangler secret put
   GATEKEEPER_VERIFIER_HMAC_SECRET` on the same Worker (observer-verifier signing key); `wrangler
   secret put CALENDAR_OAUTH_STATE_SECRET` and set `CALENDAR_OAUTH_REDIRECT_URI` on
   `athenaeum-backend`; uncomment the `GATEKEEPER_GOOGLE_CALENDAR` service binding in
   `athenaeum-backend`'s `wrangler.jsonc` and add the same binding to `athenaeum-router`'s (already
   uncommented this stage, since router→gatekeeper needs no secret to be meaningful to wire).

### 3.7 Honest gaps left for the next stage

- **Sync is single-shot, not checkpointed** (§3.4) — the next stage should replace
  `MAX_PAGES_PER_SYNC`'s bounded loop with new-notes' own cited per-page-transaction/`syncToken`
  incremental design, persisting `pageToken`/`syncToken` progress across separate `sync()` calls
  rather than looping pages within one.
- **Synthesized recurring-series master rows** (§3.4) are a placeholder, not the true master
  resource — a real implementation should also fetch/refresh `events.get(seriesId)`.
- **`occurrenceId` uses the occurrence's current start**, not its original pre-any-edit start
  (`calendar-event.ts`'s own "stable across a cancel-then-reappear cycle" ideal) — this stage has
  no way to know the original start on a first sync; flagged, not solved.
- **The email-dedup scan is O(existing facts) per `sync()` call**, not indexed by value — fine at
  this stage's scope, worth a `byValue`-style index if a workspace's fact count grows large.
- **§2's own still-open gap is unchanged**: `onDatasetTouched`'s `failedObserverIds` still has no
  `excludeObservers`-equivalent consumer — Athenaeum has no per-observation authorization concept
  yet for it to feed.
- **Real deploy is untested** (§3.6) — everything above is proven at the HTTP-mock/scripted-double
  layer; a real `wrangler dev`/`wrangler deploy` round trip against real Google credentials has
  never run, per this task's hard constraints.
