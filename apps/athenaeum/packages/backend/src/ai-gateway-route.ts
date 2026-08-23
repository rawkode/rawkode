// `ai-gateway-route.ts` — the shared Cloudflare AI Gateway URL/header builder reused by every
// real inference client in this package (`model-client-anthropic.ts`,
// `cloud-transcription-client-openai.ts`, `realtime-voice-client-openai.ts`). Full research trail
// and the scope decision behind this file's shape: docs/ai-gateway-decisions.md — deliberately
// narrower than cloudflare-os's multi-tenant `AiGatewayConfig` (`packages/workshop-backend/src/
// ai-gateway.ts`): one configured gateway, one account, pass-through provider keys (no BYOK-in-
// gateway, no Workers AI binding, no per-user billing/quota), because Athenaeum is a personal app
// with one operator's own provider secrets already in Worker env, not a platform metering many
// different users' wallets.
//
// **Per-provider passthrough endpoint, not the Universal Endpoint** (docs/ai-gateway-decisions.md
// §1, confirmed via Cloudflare's own current AI Gateway docs): `https://gateway.ai.cloudflare.com/
// v1/{account_id}/{gateway_id}/{provider}/{the provider's own original path, unchanged}` — a pure
// URL-prefix swap in front of each client's existing request/response code, not a batch envelope
// requiring reshaping every request.
//
// **Fallback rule** (docs/ai-gateway-decisions.md §3), checked once per Worker request (via
// `resolveAiGatewayRoute`, called once per DO construction in `workspace-durable-object.ts`, same
// as every other optional binding there):
//   - Both `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_NAME` set (non-empty) -> GATEWAY mode.
//   - Neither set -> DIRECT mode: unchanged from today, straight to the provider's own API host.
//   - Exactly one set -> misconfiguration: throws at construction rather than silently falling
//     back to DIRECT (mirrors cloudflare-os's own `AiGatewayConfig` constructor, which throws
//     rather than guessing a transport when `CF_AI_GATEWAY` is set without
//     `CF_AI_GATEWAY_ACCOUNT_ID`) — never a silent fallback that would look like gateway routing
//     was requested but quietly didn't happen.
//
// `CF_AI_GATEWAY_TOKEN` is independent of the mode switch: meaningful only in GATEWAY mode,
// optional even there — only required if Authenticated Gateway is turned on for the gateway in
// the Cloudflare dashboard (off is the default for a new gateway). When set, it is sent as
// `cf-aig-authorization: Bearer {token}` on every request/connect, HTTP or WebSocket alike.
//
// Provider API keys need no change under either mode: `ANTHROPIC_API_KEY`,
// `OPENAI_TRANSCRIPTION_API_KEY`, `OPENAI_REALTIME_API_KEY` keep their current names and header
// treatment (`x-api-key` / `Authorization: Bearer`) — the gateway is a URL/observability layer in
// front of the same authenticated request, not a different auth model (pass-through, not BYOK).

export interface AiGatewayRoute {
  readonly accountId: string
  readonly gatewayName: string
  /** `CF_AI_GATEWAY_TOKEN` — present only if Authenticated Gateway is configured. */
  readonly authToken?: string
}

export interface AiGatewayEnv {
  readonly CF_AI_GATEWAY_ACCOUNT_ID?: string
  readonly CF_AI_GATEWAY_NAME?: string
  readonly CF_AI_GATEWAY_TOKEN?: string
}

/** `undefined` => DIRECT mode (today's behavior, unchanged). Throws if exactly one of the two
 *  required vars is set — see this file's header comment's "Fallback rule" for why that's a loud
 *  failure, not a silent DIRECT fallback. */
export const resolveAiGatewayRoute = (env: AiGatewayEnv): AiGatewayRoute | undefined => {
  const accountId = env.CF_AI_GATEWAY_ACCOUNT_ID
  const gatewayName = env.CF_AI_GATEWAY_NAME
  const hasAccountId = accountId !== undefined && accountId.length > 0
  const hasGatewayName = gatewayName !== undefined && gatewayName.length > 0

  if (!hasAccountId && !hasGatewayName) return undefined

  if (hasAccountId && hasGatewayName) {
    const authToken = env.CF_AI_GATEWAY_TOKEN
    return {
      accountId,
      gatewayName,
      ...(authToken !== undefined && authToken.length > 0 ? { authToken } : {})
    }
  }

  throw new Error(
    "AI Gateway misconfigured: CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_NAME must both be set " +
      "(GATEWAY mode, routing every inference client through Cloudflare AI Gateway) or both be " +
      "absent (DIRECT mode, calling each provider's API directly) — exactly one was set " +
      `(CF_AI_GATEWAY_ACCOUNT_ID ${hasAccountId ? "set" : "unset"}, CF_AI_GATEWAY_NAME ${hasGatewayName ? "set" : "unset"}). ` +
      "See docs/ai-gateway-decisions.md §3."
  )
}

/** `cf-aig-authorization` header when the route carries an Authenticated Gateway token, `{}`
 *  otherwise — the same shape works for both the HTTP clients' `fetch` headers and
 *  `websocket-transport.ts`'s `connect(url, headers)`, which already accepts an arbitrary header
 *  map, so this is just one more entry in the header object each client already builds. */
export const gatewayAuthHeader = (route: AiGatewayRoute | undefined): Record<string, string> =>
  route?.authToken !== undefined ? { "cf-aig-authorization": `Bearer ${route.authToken}` } : {}

const GATEWAY_HOST = "https://gateway.ai.cloudflare.com/v1"

/** The per-provider passthrough HTTP endpoint (this file's header comment, §1) — `providerPath`
 *  is exactly what the client would otherwise send straight to the provider (e.g.
 *  `"anthropic/v1/messages"`, `"openai/audio/transcriptions"`), appended unchanged after the
 *  gateway's own `{account}/{gateway}` prefix. */
export const gatewayHttpUrl = (route: AiGatewayRoute, providerPath: string): string =>
  `${GATEWAY_HOST}/${route.accountId}/${route.gatewayName}/${providerPath}`

/** The Realtime WebSocket relay's own distinct URL shape (docs/ai-gateway-decisions.md §2) — no
 *  `/realtime` path segment, unlike the general provider-passthrough prefix rule above; taken
 *  verbatim from Cloudflare's own worked example (`wss://gateway.ai.cloudflare.com/v1/{account}/
 *  {gateway}/openai?model=...`) rather than derived from the HTTP prefix rule, since the WS relay
 *  is a distinct, special-cased feature with its own shape. Expressed with the `https://` scheme
 *  `websocket-transport.ts`'s real `fetch`-then-upgrade mechanism requires (see that file's own
 *  header comment) — the same identical host+path+query as the `wss://` form OpenAI's/Cloudflare's
 *  docs describe, just through the scheme `workerd` outbound WebSocket upgrades actually use. */
export const gatewayRealtimeWsUrl = (route: AiGatewayRoute, model: string): string =>
  `${GATEWAY_HOST}/${route.accountId}/${route.gatewayName}/openai?model=${encodeURIComponent(model)}`
