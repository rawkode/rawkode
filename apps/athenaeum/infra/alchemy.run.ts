// Athenaeum deploy-time IaC — Alchemy 2.x (Effect-based) stack.
//
// Scope: exactly one resource, the Cloudflare AI Gateway that packages/backend routes all three
// inference clients through (see packages/backend/src/ai-gateway-route.ts and
// docs/ai-gateway-decisions.md). The Workers (backend/router/gatekeeper), R2 bucket, and DO
// migrations are deliberately NOT declared here: Alchemy 2.x's Worker resource requires Workers
// authored as Effect-native `Cloudflare.Worker(...)` modules with bindings declared in Alchemy
// code — Athenaeum's Workers are plain wrangler Workers (worker_loaders, ctx.exports DOs,
// run_worker_first assets, service bindings) whose wrangler.jsonc files remain the operative
// configs. Transcribing them would be a rewrite, not a declaration; documented as future work in
// this directory's README.md.
//
// Outputs map 1:1 onto the backend's env contract (ai-gateway-route.ts):
//   accountId   -> CF_AI_GATEWAY_ACCOUNT_ID
//   gatewayName -> CF_AI_GATEWAY_NAME
// CF_AI_GATEWAY_TOKEN is NOT provisioned here: Authenticated Gateway is left off (see the
// `authentication: false` justification below), so the backend's optional token stays unset.

import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

export default Alchemy.Stack(
  "Athenaeum",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state()
  },
  Effect.gen(function* () {
    const gateway = yield* Cloudflare.AI.Gateway("Gateway", {
      // The gateway's id — the `{gateway_id}` path segment in
      // `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/...`, i.e. exactly what
      // the backend reads as CF_AI_GATEWAY_NAME.
      id: "athenaeum",

      // Personal-deployment settings (docs/ai-gateway-decisions.md's scope: one gateway, one
      // account, observability is the point):
      //
      // Request/response logging on — the primary reason this gateway exists.
      collectLogs: true,

      // Modest cache: identical repeated requests (same provider, same body) served from the
      // gateway's cache for 5 minutes. Anthropic Messages calls are rarely byte-identical and
      // the Realtime WebSocket relay is uncacheable, so this is cheap insurance rather than a
      // load-bearing optimization; 300s keeps any accidental repeat (retry loops, double
      // submits) from double-billing without ever serving meaningfully stale inference.
      cacheTtl: 300,

      // Authenticated Gateway OFF, matching the routing pass's default (ai-gateway-route.ts made
      // CF_AI_GATEWAY_TOKEN optional precisely because off is the default for a new gateway):
      // provider keys are pass-through — anyone who discovers the gateway URL still needs
      // David's own ANTHROPIC_API_KEY/OPENAI_* secrets to get a real response, so the token
      // would protect nothing but log noise, at the cost of minting/rotating a Run token and
      // one more secret binding. Flip to true + `wrangler secret put CF_AI_GATEWAY_TOKEN` if
      // unauthenticated traffic to the gateway URL ever becomes a concern.
      authentication: false
    })

    return {
      // CF_AI_GATEWAY_ACCOUNT_ID / CF_AI_GATEWAY_NAME, verbatim.
      accountId: gateway.accountId,
      gatewayName: gateway.gatewayId
    }
  })
)
