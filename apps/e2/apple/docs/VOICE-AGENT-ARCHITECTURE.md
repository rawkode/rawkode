# Enchiridion voice agent architecture

Design proposal, researched 12 September 2026. This document does not enable a
voice service, change OAuth scopes, or establish production access. It is
separate from the next release's home-screen and touch-editor work.

## Decision

Use GPT-Live for conversation and native audio, with an Enchiridion-owned
backend for reasoning and code execution. Prefer Cloudflare Agents SDK and its
Code Mode runtime, exposing a single `codemode` tool with progressive discovery
over a typed SDK of permitted operations. A two-tool discover/execute adapter is
an acceptable transport alternative, not a second implementation of the runtime.
Do not register every integration operation as a model tool or hand an agent the
application's admin RPC clients.

Example user outcome: “What should I prepare before my next meeting?” The agent
reads the next event, retrieves explicitly permitted linked notes and relevant
GitHub activity, and speaks a short answer with source references available on
iPhone. A later “add that to today's note” creates a reviewable proposed edit.
Calendar invitations and booking writes come after separate scope and conflict
handling work.

## Verified foundations and gaps

- `website/src/lib/auth.ts` verifies Cloudflare Access JWT issuer, audience,
  signature, required claims and administrator allowlist. Its owner is
  `access:<verified subject>`. `website/src/middleware.ts` enforces origin and
  same-origin POST checks. This is the current account boundary, not public
  multi-user login. Native session bootstrap must use this boundary or a
  reviewed replacement; do not merely forward an unverified email or owner
  header.
- `packages/oauth-client/src/contracts.ts` separates OAuth administration from
  integration token access. `integrations/oauth/src/admin.ts` binds account
  operations to an owner and grants connections to configured services.
  `connectOAuth` authenticates integration services using their secret binding.
  Those service grants are not per-agent or per-operation permissions.
- Google calendar, contacts and mail presets in
  `integrations/oauth/src/providers.ts` are read-only. Calendar contracts
  currently expose reads and synchronization, not event creation. GitHub's
  existing OAuth scopes may permit writes even when the intended feature is a
  read: enforce the narrower operation policy inside Enchiridion regardless of
  provider scope.
- Named admin entrypoints are bound privately by Alchemy. Some accept an owner
  from their trusted caller. They must never become model-visible capabilities,
  arbitrary URLs or public RPC proxies.
- The CarPlay entitlement alone is not an app scene, audio implementation or
  evidence of a working vehicle experience. See
  [CARPLAY-LIVE.md](CARPLAY-LIVE.md).

## Transport and orchestration

The documented Live WebRTC flow exchanges an SDP offer through the application
server using `POST /v1/live/sessions`. The project API key and session
configuration remain server-side; media tracks carry audio and a data channel
carries events. Do not copy the older Realtime ephemeral-secret/session-start
flow into this integration. The guide demonstrates browsers; a Swift WebRTC
adapter still needs a working spike.
[OpenAI WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live).

Proposed components:

1. **Native VoiceSession coordinator** owns microphone consent, audio routing,
   WebRTC, visible recording state and one active session shared by iPhone and
   CarPlay scenes. It creates an SDP offer and calls an authenticated,
   rate-limited `/api/voice/sessions` endpoint. That route name is proposed, not
   implemented.
2. **Voice gateway Worker** verifies account identity, entitlement to this
   feature, allowed origin/client flow, quotas and session ownership. It creates
   Live sessions with fixed server configuration and
   `delegation: { type: "client" }`. It returns only necessary transport
   information, never the project key.
3. **Per-session coordinator** stores bounded conversation context,
   device/session generation, delegation IDs, pending proposals and action
   receipts. An isolated Durable Object is a suitable proposed owner for this
   state. Reconnects must authenticate again and cannot attach using a session
   ID alone.
4. **Reasoning backend** receives the relevant transcript/context and a small
   Code Mode interface. Use the Responses API initially; model selection follows
   latency, task accuracy and cost evaluation rather than a hard-coded promise.
   It returns grounded findings or action proposals to the coordinator.
5. **Capability broker** executes authorized SDK operations using private
   service bindings. Provider credentials remain inside OAuth/integration
   Workers.

Live client delegation emits metadata rather than the utterance. Keep transcript
and application context, correlate `session.delegation.created` by delegation
ID, and assemble the backend request from that context. Transcript fragments can
be incomplete or wrong. Return concise results using documented append events;
receipt of an append is not evidence that speech or a provider action completed.
[OpenAI delegation guide](https://developers.openai.com/api/docs/guides/live-delegation).

Forward data-channel events over the authenticated app session to the
coordinator with sequence numbers and size limits. Treat them as client input,
never as an authorization assertion. A server-side event transport may replace
this forwarding if the selected native transport supports and verifies it; that
is a spike gate.

## Code mode contract

Code mode here is an application execution pattern, not a claim that GPT-Live
provides a general-purpose execution sandbox. The preferred SDK interface is one
`codemode({ code })` tool. Inside generated code, `codemode.search()` and
`codemode.describe()` progressively discover the configured connector methods;
the host pins the SDK version. These are documented Cloudflare APIs, while
Enchiridion connector methods below remain proposed.
[Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/).

The host binds owner, session, run, grants and cancellation context out of band.
These fields are never arguments the model can choose. SDK examples use logical
resource references; the broker resolves and checks them against current
ownership on every call. Discovery filters inaccessible methods, but enforcement
also happens at execution time. Discovery is not the security boundary.

Illustrative SDK capabilities: `calendar.upcoming`, `graph.search`,
`documents.read`, `github.activity`, and later `documents.proposeEdit` and
`calendar.proposeEvent`. These are proposed adapters, not existing APIs. Return
source IDs, timezone, freshness and partial-result flags so the model cannot
silently present stale or incomplete results as a complete day.

Generated code runs in a disposable, separately isolated runtime with strict
CPU/wall-time, memory, output and host-call budgets. No `eval` in the gateway's
privileged JavaScript context; no Node process, filesystem, environment, shell,
package installation, arbitrary imports or network socket access. A JS context
alone is not a sandbox. Use the Cloudflare dynamic Worker executor candidate
described below and adversarially test its configuration before enabling
execution; deployment packaging remains a separate engineering gate.

The only host capability is the versioned SDK broker. It checks argument
schemas, resource ownership, read/write policy, grant version and quota on every
call. Network egress exists only in allowlisted provider adapters. No general
`fetch` helper, redirects to arbitrary hosts, PDS administration, deployment
tokens or OAuth admin operations. Results from notes, mail and repositories are
untrusted data even when they contain apparent instructions or code.

Start with bounded read-only snippets. Add write proposals after the executor
and broker pass the security gate. Code can compose reads and transformations
without gaining broader authority merely because it loops or calls several SDK
methods.

## Grants and actions

Maintain three distinct authorizations: signed-in app identity; owner-granted
provider connection and provider OAuth scopes; and a revocable agent grant for
specific operations/resources. An agent grant should carry expiry, allowed
connections/calendars, methods and policy version. Never infer permission to
read all mail from permission to read a calendar. Revocation invalidates cached
grants and prevents subsequent calls from in-flight runs.

Reads within an explicitly enabled session grant need no repetitive
confirmation. For writes, the broker creates an immutable proposal containing
exact targets, normalized values, expected resource version, expiry and digest.
Present a short review on iPhone or a precise spoken confirmation in a suitable
CarPlay flow. A generic “yes” only confirms the currently presented, unchanged
proposal; a transcript containing quoted approval does not. Bind acceptance to
the authenticated session and proposal ID. Changes to time, recipients or
content require a new proposal. Destructive, externally visible or ambiguous
actions can require unlocked iPhone review. Do not ask drivers to operate the
phone.

Commit outside generated code through an audited operation runner. Use an
owner-scoped idempotency key, compare-and-set on proposal state, provider
version preconditions and provider idempotency where available. A timeout after
submission is `unknown`, not failure: reconcile before retrying. Exactly-once
external effects cannot be promised when a provider offers no suitable
primitive.

New Google event writes require the narrowest suitable scope, re-consent and any
required OAuth app configuration/review. Preserve existing read connections
while users upgrade them. Booking requires fresh availability/conflict checks
immediately before committing; it is not solved by adding a voice tool.

## Interruptions, privacy and device lifecycle

Track separate conversation and action state machines. Speech interruption
pauses or replaces the spoken response; it does not imply that a delegated write
was cancelled. An explicit stop cancels queued work and cooperatively aborts
reads. An already committed action remains committed and is reported accurately.
Fence late callbacks by session generation and delegation ID; never deliver
stale results into a replacement conversation.

Use native audio session interruption and route-change handling for calls, Siri,
Bluetooth and car disconnects. Start microphone use only with a clear user
action and visible native state; stop capture promptly on stop/disconnect.
Separate audio capture shutdown from draining final session events. Do not
assume a suspended iOS process can run an arbitrary background code agent.
Server work may reconcile an already authorized operation without continuing
microphone capture.

For normal close, send `session.close`, await `session.closed` with a bounded
finalization timeout, then release transport resources. Reconnect creates a new
session with explicit context and reconciled actions. A socket close alone is
not final usage confirmation.
[OpenAI session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations).

CarPlay needs its own supported scene and voice controls, an approved App ID and
matching signed entitlement. Gate the voice experience to its supported OS and
validate native templates against current Apple guidance before implementation.
Use audio-first interaction and defer complex review until parked. Locked-device
access is a product permission as well as an OS constraint: default to
explicitly allowed low-sensitivity capabilities, require unlock for account
changes or sensitive reads/writes, and test actual lock/protected-data behavior.
A connected car or voice recognition does not prove who is speaking.

Use `store: false` for Live initially. Keep raw audio out of application logs;
retain only bounded session context for the active task unless the user opts
into history. Redact tool arguments/results in operational logs and retain
minimal action receipts separately. Document backend/provider retention
independently; `store: false` is not a promise that every system retains
nothing. Apply per-owner session, concurrency and spend limits with a server
kill switch.

## Cloudflare Agents SDK evaluation

**Recommendation: adopt the SDK in a separate agent Worker, subject to a small
compatibility and isolation spike.** The Agents SDK uses Durable Objects for its
server-side `Agent` class. That fits the existing Worker/DO infrastructure
without moving OAuth, document or integration ownership into the agent.
[Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/).

Cloudflare's durable Code Mode runtime provides execution history, pending
approvals and snippets across hibernation. Its `DynamicWorkerExecutor` requires
a Worker Loader binding. The documented Vite plugin exports `CodemodeRuntime`;
the guide also documents a manual export for other build arrangements. Code Mode
is experimental: pin versions and qualify upgrades before production.
[Durable runtime setup](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/).

Use `DynamicWorkerExecutor` with explicit `globalOutbound: null`, a short
bounded `timeout`, no extra secret/service `bindings`, and no user-selected
modules. The documented default timeout is 60 seconds; select a tighter
voice-task budget through the spike. Network access belongs in broker adapters,
outside generated code. Verify termination and host-call cancellation rather
than assuming an executor timeout cancels an already running provider request.
[Executor reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/).

The container-based Sandbox SDK serves filesystem, shell and package-runtime
workloads. Those capabilities are unnecessary for composing Enchiridion API
operations and would increase cost and authority. Reserve Containers for a
future explicit file-analysis requirement, with a separate boundary review.
[Cloudflare Sandbox](https://developers.cloudflare.com/agents/tools/sandbox/).

Map each permitted service adapter to a connector, not an MCP server or a
generic HTTP connector. Thin framework classes may delegate to functional
modules, matching repository conventions. Bind identity into connector
construction from verified session state. Re-check current policy on invocation
and on approval resume; SDK discovery and `requiresApproval` do not establish
account authorization.

Runtime replay returns recorded results for applied calls; approval resumes by
rerunning the code. The docs require stable call order and describe rollback as
compensation, not transaction isolation. Avoid parallel connector calls in paths
that can pause. Retain the application's operation receipts and reconcile the
provider-commit/log-write crash gap. Never assume rollback recalls an invitation
or restores somebody else's concurrently edited document.
[Execution and replay semantics](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/).

Keep conversation state and execution records in separate owner-scoped storage.
The SDK execution log may retain connector arguments and results; design
retention and deletion before exposing mail or note bodies. Reducing the final
model output does not necessarily remove sensitive intermediate durable records.
Saved snippets need explicit application review, immutable versions and current
permission checks; do not automatically promote model-generated code into
reusable automation.

Add a proposed `agents/voice/alchemy.ts` deployment owner with an Agent DO
namespace, Worker Loader binding, project secret binding and only the necessary
private capability entrypoints. Root `alchemy.run.ts` should only compose it.
Existing integration DOs and OAuth secrets stay in their owning Workers;
preserve their resource IDs, migrations and grants. The website/Astro
integration should route an authenticated request to this service rather than
embed agent execution in public page rendering or PDS handlers. No agent route
may bypass current Access verification because the personal site also hosts
public content.

The checkout has no inspected Code Mode/Worker Loader wiring. Before choosing
the exact Alchemy configuration, prove that the pinned Alchemy v2 version can
emit the required binding and runtime exports, and that Deno's build/dependency
path works without requiring a parallel Wrangler deployment. A manual export is
documented; Alchemy support itself remains unverified. Inspect a staged resource
plan and upgrade/rollback behavior without replacing existing data resources.
Agents SDK also does not supply a verified Swift GPT-Live transport: keep that
spike separate.

## Subscription boundary

Codex App Server documents ChatGPT browser/device-code login and account limits.
That is a separate Codex runtime integration, not authorization to create Live
sessions using subscription credentials.
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

The proposed code-mode SDK does not require Codex App Server. Fund Live and the
reasoning backend with project API billing. If a subscription-backed Codex
backend is explored later, isolate its account/runtime per owner and retain the
same broker policy. It would not establish subscription-funded Live audio. Never
extract or reuse private ChatGPT tokens.

## Delivery gates

1. **Transport spike:** authenticated native session, microphone/route handling,
   interruption, transcript event ordering, server cancellation and final usage.
   Verify project access and select a maintainable Swift WebRTC distribution.
2. **Read-only value:** next-event briefing plus permitted linked notes/GitHub
   context. Ship only after source fidelity, freshness and latency evaluation.
3. **Code-mode gate:** progressive discovery, isolated runtime and typed SDK;
   prove owner separation, denied egress, secret non-disclosure, budget
   enforcement and prompt-injection resistance before expanding capabilities.
4. **Controlled writes:** note proposals, durable receipts and race testing;
   then calendar scope upgrade and booking-specific conflict handling.
5. **CarPlay qualification:** signed scene, supported templates, physical-car
   audio, locked phone, reconnection and interruption. Simulator success alone
   is insufficient. Watch voice is a separate constrained UX, not automatic
   parity.

Acceptance fixtures must cover cross-owner IDs, revoked service/agent grants,
malicious note instructions, unsupported SDK methods, infinite loops, output
floods, timezone/DST ambiguity, stale calendars, partial sync, corrected speech,
duplicate delegation, duplicate confirmation, stop during commit, lost provider
response and car disconnect mid-action. Assert zero unauthorized mutations and
accurate committed/failed/unknown outcomes. Measure first-audio and task
latency, source correctness, confirmation comprehension and session cost; set
release thresholds from the spike rather than inventing present-day performance
results.

Open blockers: no native Live spike, no qualified production executor, no agent
grant store or broker, no write-scope migration, no physical CarPlay voice
evidence and no production voice privacy evaluation. This architecture must
receive an independent boundary review before implementation; this document is
not that review.
