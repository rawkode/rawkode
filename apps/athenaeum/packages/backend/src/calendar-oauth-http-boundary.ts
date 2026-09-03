/**
 * Pure fixed-origin OAuth boundary response policy.
 *
 * Keeping this module free of the Worker composition root makes the launch/callback privacy
 * contract independently testable without initializing the Loro runtime. It intentionally does
 * not redeem capabilities or exchange provider codes; those operations belong to the coordinator
 * and a later configured Gatekeeper deployment.
 */

const GOOGLE_CALENDAR_LAUNCH_PATH = /^\/oauth\/google-calendar\/launch\/(ocl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const GOOGLE_CALENDAR_CALLBACK_PATH = "/oauth/google-calendar/callback"

const oauthBoundaryHeaders = (headers: Headers): Headers => {
  headers.set("Cache-Control", "no-store")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
  headers.set("X-Content-Type-Options", "nosniff")
  return headers
}

/**
 * Fixed first-party OAuth boundary. GET is intentionally read-only: only explicit POST may redeem
 * a launch capability. Provider exchange/callback finalization stays unavailable until the
 * Gatekeeper contract is mounted, so this handler never accepts or reflects raw OAuth code/state.
 */
export const handleGoogleCalendarOAuthBoundary = (request: Request, url: URL): Response | undefined => {
  const launch = url.pathname.match(GOOGLE_CALENDAR_LAUNCH_PATH)
  if (launch) {
    if (request.method === "GET") {
      return new Response("<!doctype html><title>Connect Google Calendar</title><form method=\"post\"><button type=\"submit\">Continue to Google</button></form>", {
        headers: oauthBoundaryHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8" }))
      })
    }
    if (request.method === "POST") {
      return new Response("Google Calendar authorization is not configured on this deployment.", {
        status: 501,
        headers: oauthBoundaryHeaders(new Headers({ Allow: "GET, POST" }))
      })
    }
    return new Response("Method Not Allowed", { status: 405, headers: oauthBoundaryHeaders(new Headers({ Allow: "GET, POST" })) })
  }
  if (url.pathname === GOOGLE_CALENDAR_CALLBACK_PATH) {
    return new Response("Google Calendar authorization is not configured on this deployment.", {
      status: 501,
      headers: oauthBoundaryHeaders(new Headers({ Allow: "GET" }))
    })
  }
  return undefined
}
