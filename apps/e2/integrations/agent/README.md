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
reasoning model. Keep generated code outside the privileged gateway. Actual
calendar/GitHub adapters remain to be wired through the existing private service
bindings, with the trusted owner supplied by the coordinator.

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
deno test integrations/agent/test
deno check integrations/agent/src/durable-storage.ts
deno lint integrations/agent
deno fmt --check integrations/agent
```

Seventeen tests pass. The eight broker/capability tests cover:
unauthenticated/cross-origin denial before reservation, exact provider request
and reduced response contract, forbidden client configuration and oversized SDP,
redacted failure with unknown receipt/no retry, grant revocation during reads,
invalid date/timezone/owner arguments and call budget, nested result projection
that drops internal fields, and preservation of a known session receipt when
post-creation permission checking fails. These tests perform no network
requests, start no paid sessions and do not test an executor or physical audio.
They are isolated from the root test runner until this integration is
intentionally added to the workspace.

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
