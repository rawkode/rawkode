# AI Gateway routing — architecture decisions

Status: pre-work spike, complete (design-only — no code changed this stage). Resolves the task
"route inference through Cloudflare AI Gateway (URL/header routing, observability, caching,
provider flexibility) for a single personal account" for the three real inference clients in
`packages/backend/src`: `model-client-anthropic.ts`, `cloud-transcription-client-openai.ts`,
`realtime-voice-client-openai.ts`.

**No real Cloudflare account/AI Gateway/provider API key exists in this environment.** Every URL
and header shape below is verified against Cloudflare's and OpenAI's own current documentation
(WebFetch/WebSearch, cited inline) and cross-checked against `cloudflare-os`'s own working
implementation — not fabricated, and not exercised against a live gateway here. The Implementation
stage builds the routing logic described in "Concrete construction" below and proves it exactly
the way `model-client-anthropic.test.ts` already proves request-building today: mock `HttpFetch`
(or `WebSocketTransport`), assert the real URL/headers a real fetch/WS connect would receive.

## Scope, decided explicitly

`cloudflare-os` (`docs/ai-gateway-billing.md`, `packages/workshop-backend/src/ai-gateway.ts`) is a
**multi-tenant SaaS billing many different end users**. Its AI Gateway integration exists to
solve a problem Athenaeum doesn't have:

- **Per-user OAuth-connected Cloudflare accounts** (`AuthenticatedApi.connectAccount("cloudflare")`,
  a whole gatekeeper) — so the platform can bill *someone else's* Cloudflare credits instead of its
  own. Athenaeum has one operator (David); there is no second party's account to connect.
- **A free-tier daily allowance + BYOK-balance billing switch** (`checkUsageAndBalance`,
  `DAILY_LLM_CALL_LIMIT`, `MINIMUM_CLOUDFLARE_BALANCE`, the live credit-balance read cached 5
  minutes) — this exists because different users must be metered against *different* wallets.
  A personal deployment has exactly one wallet; there's nothing to meter between users.
- **BYOK-in-gateway / Unified Billing** (provider keys stored in the Cloudflare dashboard, not in
  the Worker's own env) — this is *why* `CF_AI_GATEWAY_API_TOKEN` is required there for every
  provider on the HTTPS transport: it's the one credential cloudflare-os needs to authenticate
  itself *to the gateway*, which then supplies the real per-provider keys from its own BYOK store.
  That indirection is the point when many users share one platform-funded gateway; it is pure
  overhead when the same person who runs the Worker already holds `ANTHROPIC_API_KEY` etc. as
  Worker secrets, as Athenaeum's three clients already do today.
- **The Workers AI binding transport, `UsageSettings`/`OutOfCreditsModal`/`AccountSelectionModal`
  UI, the `getAiGatewayLogCost` cost-log lookup** — all exist to make per-user cost/quota visible
  and enforceable. Athenaeum enforces no quota and shows no per-user cost UI.

None of that is being built here. What Athenaeum needs, and gets, is strictly narrower: **one
configured gateway, one account, routing all three clients' existing pass-through provider keys
through it** for observability (request logs), caching, and the option to swap providers later
without changing call sites — the parts of AI Gateway that are genuinely useful to a single-user
app and cost nothing extra to add.

## 1. Real AI Gateway URL/auth scheme

### Universal Endpoint vs. per-provider endpoint — per-provider chosen

AI Gateway exposes two request shapes ([Universal Endpoint usage
doc](https://developers.cloudflare.com/ai-gateway/usage/universal/), confirmed via WebFetch this
stage):

- **Universal Endpoint** — `POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}`
  with a batch-array body (`[{provider, endpoint, headers, query}, ...]`), giving retries/fallback
  across providers/models in one call. This requires re-shaping every request into that envelope.
- **Per-provider ("provider-native") endpoint** —
  `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}/{the provider's own
  original path, unchanged}`. Confirmed directly for two providers this stage:
  - Anthropic: `.../anthropic/v1/messages` — the `/v1/messages` suffix is literally Anthropic's own
    path, appended after `/anthropic` ([AI Gateway Anthropic provider
    doc](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)).
  - OpenAI: `.../openai/chat/completions` and `.../openai/responses`, both confirmed the same way
    ([AI Gateway OpenAI provider doc](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)).
    A third-party summary of the same page states the general rule directly: "replace the standard
    OpenAI API URL (`https://api.openai.com/v1`) with
    `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai`" — i.e. prefix
    substitution, path otherwise untouched.

**Decision: per-provider endpoint**, because it's a pure prefix swap in front of exactly the
request/response shape each of the three clients already builds and parses (Anthropic Messages API
JSON, OpenAI multipart `/audio/transcriptions`, OpenAI Realtime WS events) — zero changes to
`toAnthropicMessage`/`parseResponseBody`/`decodeServerEvent`/etc. in any of the three files. The
Universal Endpoint's batch envelope would require wrapping and unwrapping every request/response,
for retry/fallback features this task doesn't ask for and a single personal account doesn't need.

**`/audio/transcriptions` specifically is not shown as a worked example** on Cloudflare's OpenAI
provider page (only `chat/completions` and `responses` are) — flagging this honestly rather than
treating it as independently confirmed. It is not a guess either: it follows directly from the
same prefix-substitution rule stated above and demonstrated twice (`chat/completions`,
`responses`), applied to the one remaining OpenAI path this task needs
(`/v1/audio/transcriptions` → `.../openai/audio/transcriptions`). If the Implementation stage wants
this independently confirmed before shipping, the cheap check is a single real request against a
real gateway once David has one configured — not available in this environment.

### Transport: plain HTTPS, no Workers AI binding — not cloudflare-os's binding-vs-token choice

cloudflare-os picks between two transports because it has two different needs the binding serves:
pre-authenticated in-account calls (no token needed) *and* a `WORKERS_AI` binding that also backs
an unrelated feature (`webFetch`'s `toMarkdown`), so keeping it bound is free. Athenaeum has
neither: no Workers AI usage anywhere in this codebase, and the three clients already reach the
network through their own narrow `HttpFetch`/`WebSocketTransport` seams (plain `fetch`/WS-upgrade),
not a Workers AI SDK. Adding a `WORKERS_AI` binding purely to authenticate three `fetch()` calls
that already carry their own provider bearer token would be new machinery with no matching need —
and per cloudflare-os's own doc comment, the binding transport only reaches a gateway in the
Worker's *own* Cloudflare account, an assumption this task has no way to verify or guarantee for
David's setup.

**Decision: plain HTTPS to `gateway.ai.cloudflare.com`, URL-only change, no new binding, no
`wrangler.jsonc` change.** This matches "a single Worker not needing per-provider binding
complexity" directly.

### Pass-through provider keys, not BYOK-in-gateway

Confirmed via WebFetch this stage
([AI Gateway authentication doc](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)):
the provider's own key can still be sent directly in the request (`x-api-key` for Anthropic,
`Authorization: Bearer` for OpenAI) exactly as today — AI Gateway forwards it to the provider
unchanged. BYOK lets the same key live in the Cloudflare dashboard's gateway config instead, so
the calling code sends no provider key at all; cloudflare-os depends on this because it doesn't
want individual users' — or its own platform — provider keys sitting in Worker env for every
provider that many different users route through.

**Decision: pass-through, unchanged from today.** For a single personal deployment this is
strictly simpler: `ANTHROPIC_API_KEY` / `OPENAI_TRANSCRIPTION_API_KEY` / `OPENAI_REALTIME_API_KEY`
already live as Worker secrets and already get sent as the exact headers each provider's real API
requires; BYOK would mean additionally configuring the same keys a second time in the Cloudflare
dashboard for zero behavioral gain, and would leave the three clients' existing "how do I even
know a key is configured" check (`config.apiKey === undefined`) unable to tell — the Worker would
have no key to check locally, only the gateway would know. Pass-through keeps every existing
"unconfigured → fail closed before any I/O" check exactly as it is.

### Authenticated Gateway (`cf-aig-authorization`) — optional, off by default

Confirmed via WebFetch: Authenticated Gateway is a per-gateway on/off toggle in the dashboard.
Off (the default for a new gateway): requests need no `cf-aig-authorization` header at all — the
gateway forwards anything addressed to it. On: every request (HTTP or WebSocket) must carry
`cf-aig-authorization: Bearer {token}`, where `{token}` is a **gateway-scoped "Run" token minted in
the dashboard** — this is *not* the same kind of credential as cloudflare-os's
`CF_AI_GATEWAY_API_TOKEN` (a Cloudflare account API token with `AI Gateway:Run`+`Read` REST
permissions, used there partly to read back per-call cost via
`api.cloudflare.com/.../ai-gateway/gateways/.../logs/...`). Athenaeum has no cost-log-read feature,
so this token's only job here is the `cf-aig-authorization` header.

**Decision: support it as optional.** Leaving Authenticated Gateway off is a reasonable default for
a personal gateway (anyone hitting the URL still needs David's own provider key to get a real
response — pass-through means there's no shared credential to steal by discovering the gateway
URL). Supporting the header when configured costs one optional env var and one line per request.

## 2. WebSocket/Realtime API support — empirically confirmed supported, with one live compatibility gap

Investigated empirically per instruction, not assumed. Cloudflare **does** support proxying
OpenAI's Realtime API over WebSocket: the ["Realtime WebSockets
API"](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/) is a shipped
feature (Cloudflare changelog, dated 2025-03-21: "AI Gateway now supports real-time AI
interactions with the new Realtime WebSockets API," naming OpenAI Realtime, Google Gemini Live,
Cartesia, and ElevenLabs explicitly — no beta/preview label on the changelog entry itself).

Cloudflare's own worked example (WebFetch, verbatim):

```js
const url =
  "wss://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/openai?model=gpt-4o-realtime-preview-2024-12-17";
const ws = new WebSocket(url, {
  headers: {
    "cf-aig-authorization": process.env.CLOUDFLARE_API_KEY,
    Authorization: "Bearer " + process.env.OPENAI_API_KEY,
    "OpenAI-Beta": "realtime=v1",
  },
});
```

This confirms the URL shape precisely (`wss://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai?model=...`
— note: **no `/realtime` path segment**, unlike the general provider-passthrough prefix rule from
§1; the WS relay is a distinct, special-cased feature with its own shape, taken verbatim from this
example rather than derived from the HTTP prefix rule) and that headers — not
`sec-websocket-protocol` — are the right mechanism for a non-browser caller (`workerd`'s own
outbound-WebSocket mechanism, per `websocket-transport.ts`'s existing header comment, is a real
`Headers`-bearing `fetch()` upgrade, not a browser `new WebSocket(url)` call, so this is exactly the
form Athenaeum already uses).

**Live compatibility gap found, and why it matters here:** Cloudflare's example targets
`gpt-4o-realtime-preview-2024-12-17` and sends `OpenAI-Beta: realtime=v1` — the pre-GA beta
protocol. `realtime-voice-client-openai.ts` already targets the **GA** protocol
(`gpt-realtime-2.1`, GA event/session shapes — see that file's own header comment). Checked
OpenAI's own current GA docs this stage
([`developers.openai.com/api/docs/guides/realtime-websocket`](https://developers.openai.com/api/docs/guides/realtime-websocket),
WebFetch, verbatim):

```js
const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1";
const ws = new WebSocket(url, {
  headers: {
    Authorization: "Bearer " + process.env.OPENAI_API_KEY,
    "OpenAI-Safety-Identifier": "hashed-user-id",
  },
});
```

No `OpenAI-Beta` header — and independently, a public GA compatibility report (a `litellm` GitHub
issue found via WebSearch this stage: "`gpt-realtime` (GA) fails with `OpenAI-Beta: realtime=v1`
header") states the GA endpoint **rejects** that header rather than merely ignoring it. Multiple
sources (a third-party OpenAI-ecosystem migration guide found via WebSearch) describe OpenAI's 2026
Realtime GA migration as explicitly *removing* that header as one of its breaking changes.

**Decision: gateway routing is genuinely supported for the realtime client, but the
Implementation stage must build the gateway connection from OpenAI's current GA header set
(`Authorization` + this client's already-correct GA event/session bodies), plus `cf-aig-authorization`
if configured — and must NOT copy Cloudflare's own worked example's `OpenAI-Beta` header or preview
model id verbatim.** The gateway is a transparent relay to the same OpenAI Realtime backend
(same host semantics, just fronted by `gateway.ai.cloudflare.com`); nothing in Cloudflare's docs
suggests it inspects/rewrites the JSON event frames going over the socket (checked explicitly this
stage — the WebSockets API overview doc does not describe frame-level schema handling for the
"Realtime APIs" category, only for wrapping *non*-WebSocket-native providers in a WS transport),
so a GA-shaped client that works directly against OpenAI has no documented reason to behave
differently once addressed through the gateway instead. This is inference from "documented as a
transparent proxy with no claimed schema awareness," not a confirmed live test — flagged
accordingly, same as this file's `/audio/transcriptions` gap above; a live check once David has a
real gateway is the way to fully close it.

One more caveat found (not applicable to Athenaeum's design, noted for completeness): a Cloudflare
Community report describes BYOK not being honored on Realtime WebSocket connections (the provider
key still has to be sent explicitly even with BYOK configured). Irrelevant here since §1 already
chose pass-through over BYOK for independent reasons.

**Conclusion: all three clients get gateway routing** — Anthropic Messages, OpenAI transcription,
and OpenAI Realtime voice. No client is scoped out.

## 3. Config shape

```
CF_AI_GATEWAY_ACCOUNT_ID=...      # Cloudflare account ID that owns the gateway
CF_AI_GATEWAY_NAME=...            # the gateway's name (dashboard: AI > AI Gateway)
CF_AI_GATEWAY_TOKEN=...           # optional: only if "Authenticated Gateway" is turned on for
                                   # this gateway in the dashboard — a gateway-scoped Run token,
                                   # NOT a Cloudflare account API token. Sent as
                                   # `cf-aig-authorization: Bearer {token}`.
```

**Fallback rule**, checked once per Worker request (not memoized at startup, matching every
existing "checked on every call" comment in the three clients):

- Both `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_NAME` set (non-empty) → **GATEWAY mode**: all
  three clients route through `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}/...`.
- Neither set → **DIRECT mode**: unchanged from today, straight to
  `api.anthropic.com`/`api.openai.com`.
- **Exactly one set** → treated as misconfiguration, fails loud at construction (mirrors
  cloudflare-os's own `AiGatewayConfig` constructor, which throws rather than silently guessing a
  transport when `CF_AI_GATEWAY` is set without `CF_AI_GATEWAY_ACCOUNT_ID`) — never a silent
  fallback to DIRECT that would look like gateway routing was requested but quietly didn't happen.

`CF_AI_GATEWAY_TOKEN` is independent of the mode switch: meaningful only in GATEWAY mode, optional
even there (only required if David turns on Authenticated Gateway).

**Provider API keys need no change**, confirmed: `ANTHROPIC_API_KEY`, `OPENAI_TRANSCRIPTION_API_KEY`,
`OPENAI_REALTIME_API_KEY` keep their current names, current secret-binding mechanism
(`wrangler secret put`), and current header treatment (`x-api-key` / `Authorization: Bearer`) in
both modes — §1's pass-through decision is exactly why: the gateway is a URL/observability layer
in front of the same authenticated request, not a different auth model.

### What David needs to configure to turn this on for real

1. Create (or use the auto-created default) AI Gateway in the Cloudflare dashboard for his
   account — no code-side setup beyond that.
2. Set `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_NAME` as `wrangler.jsonc` vars (not secrets —
   an account ID and a gateway name are not sensitive) on the real deployment.
3. Leave "Authenticated Gateway" off (simplest) or, if turned on, mint a Run token in the
   dashboard and `wrangler secret put CF_AI_GATEWAY_TOKEN`.
4. Nothing else changes: `ANTHROPIC_API_KEY` / `OPENAI_TRANSCRIPTION_API_KEY` /
   `OPENAI_REALTIME_API_KEY` continue to be set exactly as documented in each client's own header
   comment today.

## Concrete URL/header construction for the Implementation stage

A single shared helper (new module, e.g. `ai-gateway-route.ts`, sitting alongside `HttpFetch` in
`model-client-anthropic.ts` the same way `websocket-transport.ts` already sits beside it) reads the
three env vars once and hands each client a small route object:

```ts
export interface AiGatewayRoute {
  readonly accountId: string
  readonly gatewayName: string
  readonly authToken?: string   // CF_AI_GATEWAY_TOKEN, present only if configured
}

// undefined => DIRECT mode. Throws if exactly one of the two required vars is set (see
// "misconfiguration" rule above) rather than silently choosing DIRECT.
export function resolveAiGatewayRoute(env: {
  CF_AI_GATEWAY_ACCOUNT_ID?: string
  CF_AI_GATEWAY_NAME?: string
  CF_AI_GATEWAY_TOKEN?: string
}): AiGatewayRoute | undefined

// `cf-aig-authorization` header if route.authToken is set, {} otherwise — same header object
// shape for both the HTTP clients and the WebSocket client.
export function gatewayAuthHeader(route: AiGatewayRoute | undefined): Record<string, string>
```

Constructed once in `workspace-durable-object.ts` (`const gatewayRoute =
resolveAiGatewayRoute(env)`) and threaded into all three `make*Live` configs as one more optional
field, alongside each client's existing `apiKey`:

**`model-client-anthropic.ts`** (`ModelClientAnthropicConfig.gateway?: AiGatewayRoute`):

```
url:     gatewayRoute
           ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`
           : "https://api.anthropic.com/v1/messages"
headers: { "content-type": "application/json", "x-api-key": apiKey,
           "anthropic-version": "2023-06-01", ...gatewayAuthHeader(gatewayRoute) }
```

**`cloud-transcription-client-openai.ts`** (`CloudTranscriptionClientOpenAIConfig.gateway?`):

```
url:     gatewayRoute
           ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/openai/audio/transcriptions`
           : "https://api.openai.com/v1/audio/transcriptions"
headers: { Authorization: `Bearer ${apiKey}`, ...gatewayAuthHeader(gatewayRoute) }
body:    unchanged (FormData)
```

**`realtime-voice-client-openai.ts`** (`RealtimeVoiceClientOpenAIConfig.gateway?`):

```
url:     gatewayRoute
           ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/openai?model=${model}`
           : `https://api.openai.com/v1/realtime?model=${model}`
headers: { Authorization: `Bearer ${apiKey}`, ...gatewayAuthHeader(gatewayRoute) }
```

(No `OpenAI-Beta` header in either mode — see §2's live-compatibility-gap finding. No change to
`websocket-transport.ts`: `connect(url, headers)` already accepts an arbitrary header map, so the
gateway's extra `cf-aig-authorization` header is just one more entry in the object the client
already builds.)

Tests: reuse each file's existing mocked-transport pattern unchanged (`mockHttpFetch`/
`RecordedFetchCall` in the HTTP clients' test files, the scripted `WebSocketLike` double in
`realtime-voice-client-openai.test.ts`) — add one case per client asserting DIRECT-mode URL/headers
are unchanged from today (`gateway: undefined`, the default — existing assertions keep passing
as-is) and one asserting GATEWAY-mode URL/headers match the shapes above, including
`cf-aig-authorization` appearing only when a token is configured. No new mocking infrastructure
needed; this is the same "mock only the transport" discipline every one of these files already
documents in its own header comment.

## Final scope

| Client | Gateway routing | Notes |
|---|---|---|
| `model-client-anthropic.ts` | Yes | Per-provider endpoint, pass-through `x-api-key`, unchanged request/response parsing. |
| `cloud-transcription-client-openai.ts` | Yes | Per-provider endpoint (`/audio/transcriptions` path unverified by a worked Cloudflare example, but follows the documented prefix rule directly — see §1), pass-through `Authorization`. |
| `realtime-voice-client-openai.ts` | Yes | Empirically confirmed supported (§2); GA header/model set carried through unchanged, Cloudflare's own stale (`OpenAI-Beta`, preview-model) example deliberately NOT copied. |

All three switch on the identical `resolveAiGatewayRoute(env)` result — one gateway, one account,
per the hard-constrained scope — with DIRECT mode (today's behavior) as the untouched fallback
whenever `CF_AI_GATEWAY_ACCOUNT_ID`/`CF_AI_GATEWAY_NAME` are absent, exactly as every other optional
binding in this codebase (`GATEKEEPER_GOOGLE_CALENDAR`, `LOADER`, `MEETING_AUDIO`) already fails
clean rather than gateway-mandatory-or-broken.
