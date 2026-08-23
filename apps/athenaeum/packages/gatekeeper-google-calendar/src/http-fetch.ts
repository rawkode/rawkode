// The one seam `GoogleCalendarClientReal` reaches the network through — same pattern and same
// rationale as `@athenaeum/backend`'s `model-client-anthropic.ts#HttpFetch`: a minimal
// `fetch`-shaped `Context.Tag`, deliberately the ONLY thing this package's tests mock (per this
// task's hard constraint: "mock only the HTTP call, not the whole client, exactly like Phase 3's
// ModelClientAnthropic pattern"). Every other line in `google-calendar-client-real.ts` (URL/body
// construction, response parsing, error mapping) runs for real in tests, against a fake `fetch`.

import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

export class HttpFetch extends Context.Tag("@athenaeum/gatekeeper-google-calendar/HttpFetch")<
  HttpFetch,
  { readonly fetch: (url: string, init: RequestInit) => Promise<Response> }
>() {}

/** Production default: the real global `fetch` (workerd, subject to `global_fetch_strictly_public`
 *  — see this package's `wrangler.jsonc`). */
export const HttpFetchLive: Layer.Layer<HttpFetch> = Layer.succeed(HttpFetch, {
  fetch: (url, init) => fetch(url, init)
})
