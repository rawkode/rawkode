// Proves `resolveAiGatewayRoute`'s fallback rule (docs/ai-gateway-decisions.md §3) and the small
// URL/header builders every real inference client's own gateway tests exercise indirectly
// (model-client-anthropic.test.ts, cloud-transcription-client-openai.test.ts,
// realtime-voice-client-openai.test.ts each assert the DIRECT/GATEWAY URL/header shapes those
// builders produce for their own provider) — this file covers the shared logic directly, once.

import { describe, expect, it } from "vitest"
import { gatewayAuthHeader, gatewayHttpUrl, gatewayRealtimeWsUrl, resolveAiGatewayRoute } from "../src/ai-gateway-route.js"

describe("resolveAiGatewayRoute: fallback rule", () => {
  it("returns undefined (DIRECT mode) when both vars are absent", () => {
    expect(resolveAiGatewayRoute({})).toBeUndefined()
  })

  it("returns undefined (DIRECT mode) when both vars are present but empty strings", () => {
    expect(resolveAiGatewayRoute({ CF_AI_GATEWAY_ACCOUNT_ID: "", CF_AI_GATEWAY_NAME: "" })).toBeUndefined()
  })

  it("returns a route (GATEWAY mode) when both vars are set", () => {
    const route = resolveAiGatewayRoute({ CF_AI_GATEWAY_ACCOUNT_ID: "acct-123", CF_AI_GATEWAY_NAME: "my-gateway" })
    expect(route).toEqual({ accountId: "acct-123", gatewayName: "my-gateway" })
  })

  it("carries CF_AI_GATEWAY_TOKEN as authToken when set", () => {
    const route = resolveAiGatewayRoute({
      CF_AI_GATEWAY_ACCOUNT_ID: "acct-123",
      CF_AI_GATEWAY_NAME: "my-gateway",
      CF_AI_GATEWAY_TOKEN: "run-token-xyz"
    })
    expect(route).toEqual({ accountId: "acct-123", gatewayName: "my-gateway", authToken: "run-token-xyz" })
  })

  it("omits authToken entirely when CF_AI_GATEWAY_TOKEN is an empty string", () => {
    const route = resolveAiGatewayRoute({
      CF_AI_GATEWAY_ACCOUNT_ID: "acct-123",
      CF_AI_GATEWAY_NAME: "my-gateway",
      CF_AI_GATEWAY_TOKEN: ""
    })
    expect(route).toEqual({ accountId: "acct-123", gatewayName: "my-gateway" })
    expect("authToken" in (route ?? {})).toBe(false)
  })

  it("throws when only CF_AI_GATEWAY_ACCOUNT_ID is set", () => {
    expect(() => resolveAiGatewayRoute({ CF_AI_GATEWAY_ACCOUNT_ID: "acct-123" })).toThrow(/misconfigured/i)
  })

  it("throws when only CF_AI_GATEWAY_NAME is set", () => {
    expect(() => resolveAiGatewayRoute({ CF_AI_GATEWAY_NAME: "my-gateway" })).toThrow(/misconfigured/i)
  })
})

describe("gatewayAuthHeader", () => {
  it("returns {} when the route is undefined (DIRECT mode)", () => {
    expect(gatewayAuthHeader(undefined)).toEqual({})
  })

  it("returns {} when the route has no authToken", () => {
    expect(gatewayAuthHeader({ accountId: "acct-123", gatewayName: "my-gateway" })).toEqual({})
  })

  it("returns cf-aig-authorization: Bearer {token} when the route has an authToken", () => {
    expect(
      gatewayAuthHeader({ accountId: "acct-123", gatewayName: "my-gateway", authToken: "run-token-xyz" })
    ).toEqual({ "cf-aig-authorization": "Bearer run-token-xyz" })
  })
})

describe("gatewayHttpUrl / gatewayRealtimeWsUrl", () => {
  const route = { accountId: "acct-123", gatewayName: "my-gateway" }

  it("builds the per-provider passthrough URL, path unchanged after the account/gateway prefix", () => {
    expect(gatewayHttpUrl(route, "anthropic/v1/messages")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/anthropic/v1/messages"
    )
    expect(gatewayHttpUrl(route, "openai/audio/transcriptions")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/openai/audio/transcriptions"
    )
  })

  it("builds the Realtime WebSockets relay URL — no /realtime path segment, model as a query param", () => {
    expect(gatewayRealtimeWsUrl(route, "gpt-realtime-2.1")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/openai?model=gpt-realtime-2.1"
    )
  })

  it("URL-encodes the model query parameter", () => {
    expect(gatewayRealtimeWsUrl(route, "model with spaces")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/openai?model=model%20with%20spaces"
    )
  })
})
