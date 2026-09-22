# Enchiridion voice runtime

The private Worker and owner Durable Object are implemented in `src/index.ts`,
with deployment ownership in `alchemy.ts`. Release and real spoken-conversation
verification remain separate: these files alone do not prove production
availability.

The website forwards authenticated `/api/voice/sessions` requests to the Worker.
Both Worker and Durable Object verify Access identity; the persisted ledger pins
its owner. A validated explicit Start request enables the owner's voice grant.
POST `/api/voice/sessions/:id/end` checks ownership, calls the provider hangup
endpoint and releases quota only after a successful provider response. This
confirms hangup acceptance, not final usage accounting. Failed hangup retains
quota and permits an explicit retry. POST `/api/voice/sessions/:id/day` exposes
only calendar and GitHub briefing data and requires an active persisted session
before and after the read. It is not a general tools or code-execution endpoint.

An ongoing session uses persisted grant version and created state, independently
of the short creation lease. The creation broker invokes its attachment hook
after recording the provider session and before returning SDP.

Five runtime tests cover explicit admission, foreign-owner denial, provider
hangup success/failure, idempotent close, revoked grants and ongoing
authorization past the creation lease. Together with existing suites, 31 tests
pass locally. No paid provider session or real audio is exercised by these
tests.

The following sections describe earlier contracts and their remaining limits;
references to the original unmounted spike are historical implementation notes.

The owner DO attaches an authenticated server control socket before returning
SDP. Only that sideband executes delegated reasoning. Code runs in an isolated
Cloudflare Dynamic Worker through one code tool; it can access only the bound
day reader. The model cannot select owners, credentials or arbitrary network
endpoints. Reflected audio is discarded. A lost sideband or failed attach
invokes trusted provider hangup cleanup independent of browser JWT expiry.
Provider `session.closed` is distinct from hangup acceptance for final usage
accounting.

Startup body reads, authentication, secret retrieval, day-reader construction,
provider HTTP and sideband attachment each have explicit finite deadlines.

## Current implementation

- `session.ts`: validates same-origin authenticated creation, bounded SDP input,
  request identity and device timezone. The host owns the model, prompt and key.
  It records the provider session before attaching server control and returning
  SDP. Unknown creation outcomes retain quota and never retry automatically.
- `runtime.ts`, `index.ts`, `alchemy.ts`: private service binding and one
  Durable Object per verified owner. Start, day reads and end all check
  ownership. Trusted shutdown uses the persisted receipt even after the browser
  JWT expires.
- `reservations.ts`: atomic admission, grant epochs, creation leases,
  active-call authorization and provider-confirmed closure. Prior-day closed
  records archive transactionally without allowing request-ID replay.
- `sideband.ts`: server-only delegation execution, ordered bounded transcript
  fragments, correlated spoken results and provider close confirmation. Raw
  audio events are discarded. Disconnect alone does not release an uncertain
  call.
- `reasoner.ts`: GPT-Live delegates reasoning to GPT-5 Mini with one Cloudflare
  code-mode tool for graph and day reads, tasks, Supertag definitions, and graph
  item writes. Explicit requests and follow-up approvals carry through the
  conversation; repeated approval is not required for the same scoped action.
  Generated code never receives the project key.
- `entity-tools.ts`: owner-bound item creation, readback and revision-checked
  field updates, including bookmarks. The shared runner blocks further writes
  after an uncertain outcome. Identical creation calls coalesce within one turn;
  the entity API does not provide durable cross-turn creation idempotency. Local
  migrated SQLite tests verify saved URLs and stale-edit rejection; this is not
  evidence of a successful physical iPhone spoken mutation.
- `execution-limits.ts`: network-denied sandbox loader, configured
  CPU/subrequest budgets and bounded model-facing results. Generated logs are
  discarded. Code-mode execution is stateless so tool results are not retained
  in a facet.
- `day-reader.ts`: fixed authenticated GraphQL requests through the API binding,
  verifies returned owner and civil date bounds, preserves section completeness,
  and isolates slow calendar/GitHub sources. DST boundaries use Temporal.

## Delivery and qualification

The root stack composes this Worker and the website proxy. Production binds the
existing user-supplied Cloudflare secret through `stored-secret.ts`; deployment
does not read its value. Other stages declare their own Alchemy secret from
`OPENAI_API_KEY`. Deploy using Alchemy and the explicit production stage. Do not
bypass missing existing integration secrets by changing ownership of their
deployed resources.

Native iPhone WebRTC, explicit start/mute/end controls and captions compile. The
UI opening journey and caption projection tests pass. No real provider call,
physical microphone journey, Mac conversation or CarPlay launch has been
qualified. A working local screen is not a completed voice feature.

Run contract tests and build checks:

```sh
deno test --allow-env integrations/agent/test website/test/voice.test.ts
deno check alchemy.run.ts
deno lint integrations/agent
deno task build:workers
```

The separate `test/codemode-smoke.mjs` runs actual installed SDK/workerd with
fixture data and no paid provider. It checks owner-bound reads, network/key
isolation and execution deadlines. Passing mocked tests is not a substitute for
this runtime qualification or a deployed spoken conversation.

Voice startup appends one brief English greeting after the server attaches to
the created session. The model chooses natural wording using the conversation
context, including whether it is starting or resuming. The greeting then yields
to the caller. It does not look up personal data, change graph content, or
repeat on reflected startup events. Acceptance and rejection are tracked without
logging the spoken content, and rejection does not prevent the caller from
speaking. As with tool replies, input audio must continue through silence for
the greeting to play. See
[greeting guidance](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks).

Relevant official contracts:

- [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [Server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)
- [Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/ai-sdk/)
