# Voice foundation — isolated, not deployed

Verified 13 September 2026. This directory contains an executable contract
spike, not a working voice assistant. No route is mounted, no credential or
deployment is created, and no generated code is executed. Existing iPhone,
CarPlay and desktop applications are unchanged.

## Public contracts rechecked

OpenAI currently documents `POST https://api.openai.com/v1/live/sessions` with
JSON `session` and `transport: { type: "webrtc", sdp }`. The application server
holds the project key. The response's `session.id` and `transport.sdp` are used
by the client. Session creation starts the call; the data channel must receive
`session.started`. Initialization can incur a charge even before an established
conversation. This spike uses that contract, not Realtime client-secret or SDP
multipart examples.
[OpenAI WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live).

Client delegation is documented and suits application-controlled code execution.
Its delegation event contains metadata; the app must collect transcript events
and correlate results using the delegation ID. This spike does not yet handle
that event stream.
[OpenAI delegation guide](https://developers.openai.com/api/docs/guides/live-delegation).

Cloudflare documents one `codemode` tool backed by connectors, including a
manual `CodemodeRuntime` export when not using its Vite plugin. That allows an
eventual non-Vite integration rather than requiring the website to adopt another
build system.
[Durable Code Mode](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/).

The executor requires a Worker Loader. `globalOutbound: null` blocks direct
network access; the documented execution timeout defaults to 60 seconds. Our
voice executor should explicitly set a shorter limit and expose only the owner-
bound connector.
[Executor reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/).

Local inspection also found `WorkerLoader` support in the installed Alchemy
package (`node_modules/alchemy/src/Cloudflare/Workers/WorkerLoader.ts` and
`WorkerAsyncBindings.ts`). This narrows the earlier architecture memo's open
question: a binding implementation exists, but the Agents/Code Mode version,
facet export, build packaging and deployed isolation are still unqualified.

## Implemented surface

`src/session.ts` exports `fetchVoiceSession(request, env, dependencies)` for a
future authenticated `/api/voice/sessions` route. It reuses the existing Access
JWT verifier and same-origin POST policy. Native clients must send the same
Origin header as their existing authenticated requests. Requests contain only
`sdp`, `device` (`iphone`, `carplay`, `mac`) and a request ID. They cannot
choose an owner, model, system instructions, upstream endpoint or project key.

The handler requires a host-provided `reserve(identity, requestID, device)`
implementation. `src/reservations.ts` now supplies that implementation using an
atomic owner-scoped ledger; `src/durable-storage.ts` adapts actual Cloudflare
Durable Object storage transactions. There is no in-memory production fallback.
A permit is checked before creation and after the provider response. A created
session is recorded before returning only session ID and SDP. Failed or
uncertain attempts retain an `unknown` outcome and are never automatically
retried. Provider payloads and project secrets are excluded from client error
bodies. `store: false` is selected server-side; this does not imply zero
provider retention.

`src/capabilities.ts` exports an owner/grant-bound `briefing({date,timeZone})`
function for one future Code Mode connector. Only four calls per instance are
allowed. Arguments cannot carry owner IDs or other methods; invalid civil dates
and timezones are rejected. Grants are checked again after asynchronous reads.
Results preserve source references, fetch time and partial-data status. Calendar
or document writes, OAuth administration, PDS access and arbitrary fetching are
absent from the interface.

This module does not evaluate JavaScript. Register its narrow read operation
inside a qualified Cloudflare connector; expose `runtime.tool()` once to the
reasoning model. Keep generated code outside the privileged gateway.
`src/day-reader.ts` now implements the calendar/GitHub adapter through the
existing private API binding, with verified owner and Access assertion captured
by its factory. The service binding still needs deployment wiring.

## Root integration and release gates

1. Wire the implemented owner-scoped reservation ledger to one Durable Object
   per verified owner. Enable it only through trusted feature authorization.
   Agent read grants still need a persistent store; session admission is not
   permission to read every integration. Implement provider lifecycle
   reconciliation before public rollout; uncertain attempts deliberately keep
   their capacity reserved.
2. Add deployment ownership in this directory through Alchemy, compose it at
   root, bind the project secret through Secrets Store, and route the
   authenticated website path. Do not create a second Wrangler deployment or
   copy credentials. No such deployment files are included in this spike because
   the runtime and policy dependencies are not ready.
3. Pin and install the qualified Agents/Code Mode packages, wire Worker Loader
   and facet exports, and prove network denial, hard execution timeout,
   host-call cancellation, output limits, owner separation and no secret
   visibility.
4. Add bounded whole-request deadlines including body streaming, authorization,
   quota and receipt storage. Current provider fetch has a ten-second abort
   signal and capability reads receive a five-second signal; the injected
   adapters must honor cancellation. This is not proof that every dependency
   terminates, nor a substitute for the runtime's enforced deadline.
5. Verify this project's GPT-Live access with an explicitly configured test key,
   a genuine native SDP offer and returned answer. Contract fixtures below do
   not prove provider access or working audio. No paid API call was made.
6. Native iPhone/macOS coordinators need microphone consent, WebRTC, transcript
   ordering, playback interruption, route changes and a visible stop action.
   CarPlay additionally needs the approved scene/template integration, locked-
   phone behavior and physical-car testing. Entitlements do not provide these.
7. Mount delegation handling only after the read adapters return actual sourced
   data, then evaluate a next-meeting briefing. Persist neither raw audio nor
   broad tool results by default. Add write proposals as a later scope.

Until these gates pass, do not enable the route or advertise voice availability.
The real unit-test authorization path is injected for fixture isolation; the
production default imports the existing Access verifier. There is no custom JWT
parser or trust in an arbitrary owner header.

## Verification

```sh
deno test --allow-env integrations/agent/test
deno check integrations/agent/src/durable-storage.ts
deno lint integrations/agent
deno fmt --check integrations/agent
```

Twenty-seven tests pass. The eight broker/capability tests cover:
unauthenticated/cross-origin denial before reservation, exact provider request
and reduced response contract, forbidden client configuration and oversized SDP,
redacted failure with unknown receipt/no retry, grant revocation during reads,
invalid date/timezone/owner arguments and call budget, nested result projection
that drops internal fields, and preservation of a known session receipt when
post-creation permission checking fails. These tests perform no network
requests, start no paid sessions and do not test an executor or physical audio.
The root test runner now includes these tests, and the root typecheck includes
the broker, day reader and Cloudflare storage adapter. This does not mount or
deploy an agent Worker.

## Durable session reservations

The reservation module is functional and framework-independent; the production
storage adapter delegates to `DurableObjectStorage.transaction`. A Worker must
route a verified owner's requests to that owner's Durable Object. The ledger
also stores its owner and rejects access through an instance bound to another
owner, protecting against accidental namespace reuse.

Inside that Durable Object, construct the binding once:

```ts
const reservations = createVoiceReservations(
	durableVoiceStorage(ctx.storage),
	verifiedOwnerID,
);
// The request handler receives reserve: reservations.reserve.
// setEnabled(true) is a separate trusted, explicitly authorized feature action.
```

The default policy admits one concurrent session and twenty creation attempts
per UTC day. Admission, request-ID deduplication and receipt writes are atomic.
A new ledger starts disabled. Revocation increments a persisted policy version;
re-enabling does not reactivate old permits. These are session-count limits, not
measured-dollar or call-duration billing limits.

Creation has a thirty-second lease. A crashed/expired reservation becomes
`unknown`, retaining concurrency and attempt quota. A timeout is never assumed
free. Known created sessions retain their ID across restarts, subsequent unknown
writes and revocation. A trusted provider-close receipt must match that ID;
releasing an unknown attempt requires independently verified no-session
evidence. A late known creation response supersedes earlier no-session
reconciliation and restores the active receipt, so the identifier is never
discarded.

`receipts()` gives reconciliation code an owner-scoped view without nonce, SDP,
credentials or audio. It is not a public model capability. `reconcile()` and
`setEnabled()` must remain private trusted lifecycle operations. Idempotency is
at-most-one admitted creation per retained request ID, not provider exactly-once
execution. Replay returns no new permit; it does not replay SDP or start another
paid session.

This bounded ledger retains at most 128 receipt/tombstone records and then fails
closed. It never silently evicts old IDs to make quota available. A reviewed
SQLite archival/idempotency-retention migration is required for long-term use;
do not reset the ledger or delete tombstones to bypass that limit. Closed
receipts still count toward that day's attempt quota. UTC rollover permits new
IDs but never replays old ones.

Nine additional tests cover owner isolation/default denial, racing admissions
and replay across instances, restart after lease expiry, durable receipts and
revocation, daily rollover, atomic commit failure, late known receipts, bounded
capacity, and the actual session handler using this ledger to make only one
provider request during a duplicate race. The storage fixture serializes and
atomically commits durable bytes across simulated instances; no deployed Durable
Object or real provider was contacted. The production adapter separately
typechecks against installed Cloudflare runtime types.

## Authenticated day reader

`createApiDayReader(request, config, API)` authenticates an existing trusted
website request using the same Access verifier as the API. It captures the
verified owner and assertion in a private closure. The returned `readDay`
function fits `createDayCapabilities`; its owner argument is supplied by that
trusted capability broker, never exposed as generated-code input. The reader
rejects a mismatching host owner before calling a service and verifies
`data.me.id` again before releasing results. Assertions and provider credentials
are absent from its return value.

Both fixed queries are validated against the current Google/GitHub GraphQL
schema. It calls only `API.fetch` at the configured website origin's
`/api/graphql` path; there is no model-selected URL, query or authorization
header. Calendar and GitHub run concurrently as separate requests, each
requiring its own completion metadata. Missing metadata, transport failures, or
GraphQL error envelopes mark only that section unavailable and partial;
successful sections remain usable. Every response independently verifies the
bound owner and exact day range. A foreign owner or HTTP 401/403 rejects the
entire operation. Mount only after the API partial-metadata change is deployed.

Civil day boundaries use pinned `@js-temporal/polyfill` 0.5.1. Convert the
requested PlainDate and next PlainDate separately to zoned starts of day, then
to instants. This handles short/long DST days without adding 24 hours to UTC. A
civil date skipped by a timezone transition is rejected if conversion changes
its PlainDate. The API behavior is specified in
[Temporal's PlainDate documentation](https://tc39.es/proposal-temporal/docs/plaindate.html#toZonedDateTime);
the pinned implementation is the
[Temporal polyfill project](https://github.com/js-temporal/temporal-polyfill).
The root import map now explicitly pins this dependency; its direct-specifier
lock entry was added through Deno.

Calendar all-day items carry `allDay: true`. Their exclusive date-only end is
converted in the requested timezone and preserved as the end boundary; clients
must present them as all-day items rather than midnight appointments. Missing or
malformed items are omitted with their section marked partial. Source IDs are
stable provider-prefixed hashes of validated connection/resource identities,
with matching event/activity IDs and safe HTTPS source links. No extra provider
fields are forwarded.

`fetchedAt` records when the API read attempt finishes; an available section has
`observedAt`, its **API response observation time**. An unavailable section has
no observation timestamp and has `status: "unavailable"` plus `partial: true`.
They are not provider synchronization times. The current schema offers no source
sync timestamp, so `sourceFreshness: "unknown"` remains explicit. Calendar and
GitHub section partial flags survive projection, and overall `partial` is true
if either section is incomplete or truncated. The adapter has a 256 KiB incoming
body cap per source, at most twenty entries per section, and a 20 KiB result
cap. Each source has an actual abort signal and a two-second hard deadline,
within the overall five-second budget. Caller cancellation aborts both requests
and rejects the whole operation. An injected binding that ignores AbortSignal
cannot keep the caller waiting indefinitely.

Ten adapter tests cover exact GraphQL query/variables/authentication forwarding,
real-schema validation, a 23-hour and 25-hour London day, the skipped Samoa
civil date, all-day semantics, observation time and section metadata,
cross-owner rejection, GraphQL errors/missing completeness metadata, ignored
cancellation, fast-calendar/hung-GitHub isolation, successful empty days, and
oversized bodies. Authentication is injected only in transport fixtures;
production defaults to the existing JWT verifier. No live account data or paid
voice service was accessed by these tests.
