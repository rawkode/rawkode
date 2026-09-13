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
implementation. This is deliberately mandatory: no in-memory quota or implicit
allow fallback pretends to be production authorization. A permit is checked
before creation and after the provider response. A created session is recorded
before returning only session ID and SDP. Failed or uncertain attempts retain an
`unknown` outcome and are never automatically retried. Provider payloads and
project secrets are excluded from client error bodies. `store: false` is
selected server-side; this does not imply zero provider retention.

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

1. Implement durable, owner-bound session permits and agent grants, including
   quota, concurrency, request-ID deduplication, revocation, lease expiry and
   reconciliation of unknown outcomes. A recorded `created` receipt must remain
   discoverable if the subsequent permission check fails. Close or reconcile
   that provider session through a separately verified lifecycle adapter.
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
deno test integrations/agent/test/foundation.test.ts
deno lint integrations/agent
deno fmt --check integrations/agent
```

Eight tests pass: unauthenticated/cross-origin denial before reservation, exact
provider request and reduced response contract, forbidden client configuration
and oversized SDP, redacted failure with unknown receipt/no retry, grant
revocation during reads, invalid date/timezone/owner arguments and call budget,
nested result projection that drops internal fields, and preservation of a known
session receipt when post-creation permission checking fails. These tests
perform no network requests, start no paid sessions and do not test an executor
or physical audio. They are isolated from the root test runner until this
integration is intentionally added to the workspace.
