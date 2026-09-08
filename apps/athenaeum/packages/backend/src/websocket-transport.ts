// `WebSocketTransport` — the WebSocket analogue of `model-client-anthropic.ts`'s `HttpFetch`: the
// one seam `realtime-voice-client-openai.ts` reaches an actual network socket through, so a test
// can mock only the transport layer (never the client's own event-encoding/decoding logic), per
// this task's hard constraint ("proven via HTTP/WebSocket-layer-mocked tests exactly like...
// Phase 5's google-calendar-client-real.ts").
//
// **Real production shape, confirmed this stage (WebFetch against Cloudflare's own current Workers
// docs, "Using WebSockets" example): a Cloudflare Worker makes an OUTBOUND WebSocket connection by
// `fetch()`-ing the target URL with an `Upgrade: websocket` header, then reading `response.
// webSocket` and calling `.accept()`** — NOT the browser `new WebSocket(url)` constructor, which
// `workerd` does not support for outbound connections the way a browser or Node does. This
// `connect` signature is shaped around that real mechanism (`fetch`-then-upgrade), not a
// `new WebSocket(...)` call, so the real `Layer` below is what an actual Worker deployment needs,
// not a browser-shaped stand-in that would need rewriting later.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/** The minimal surface this client needs from a live socket — deliberately narrower than the
 *  full DOM/`workerd` `WebSocket` type (no `binaryType`, `bufferedAmount`, `ping`/`pong`, etc.):
 *  same "only what the caller actually uses" discipline as `HttpFetch`'s narrowed `fetch` shape. */
export interface WebSocketLike {
  readonly send: (data: string) => void
  readonly close: () => void
  readonly addEventListener: (
    type: "message" | "close" | "error",
    listener: (event: { readonly data?: unknown }) => void
  ) => void
}

export class WebSocketConnectFailed {
  readonly _tag = "WebSocketConnectFailed"
  constructor(readonly message: string) {}
}

export class WebSocketTransport extends Context.Tag("@athenaeum/backend/WebSocketTransport")<
  WebSocketTransport,
  {
    readonly connect: (
      url: string,
      headers: Record<string, string>
    ) => Effect.Effect<WebSocketLike, WebSocketConnectFailed>
  }
>() {}

/** Production default: the real `fetch`-then-upgrade mechanism confirmed above. Subject to the
 *  same `global_fetch_strictly_public` compatibility-flag consideration `HttpFetch`'s own doc
 *  comment already flags for outbound `fetch` calls from this project's Workers. */
export const WebSocketTransportLive: Layer.Layer<WebSocketTransport> = Layer.succeed(WebSocketTransport, {
  connect: (url, headers) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, { headers: { ...headers, Upgrade: "websocket" } })
        const ws = (response as unknown as { webSocket?: WebSocketLike & { accept: () => void } }).webSocket
        if (ws === undefined) {
          throw new Error(`server at ${url} did not accept the WebSocket upgrade`)
        }
        ws.accept()
        return ws
      },
      catch: (cause) =>
        new WebSocketConnectFailed(`WebSocket connect to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
})
