import { describe, expect, it } from "vitest"
import { handleGoogleCalendarOAuthBoundary } from "../src/calendar-oauth-http-boundary.js"

const launchUrl = "https://athenaeum.example/oauth/google-calendar/launch/ocl_3fa85f64-5717-4562-b3fc-2c963f66afa6"

describe("Google Calendar fixed OAuth HTTP boundary", () => {
  it("keeps GET launch read-only and private", async () => {
    const response = handleGoogleCalendarOAuthBoundary(new Request(launchUrl), new URL(launchUrl))!
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'")
    expect(await response.text()).not.toContain("state=")
  })

  it("does not consume or reflect OAuth material while provider exchange is unconfigured", async () => {
    const request = new Request(launchUrl, { method: "POST", body: "code=secret-code&state=secret-state" })
    const response = handleGoogleCalendarOAuthBoundary(request, new URL(launchUrl))!
    expect(response.status).toBe(501)
    expect(await response.text()).not.toContain("secret-")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("does not reflect callback query material", async () => {
    const callback = "https://athenaeum.example/oauth/google-calendar/callback?code=secret-code&state=secret-state"
    const response = handleGoogleCalendarOAuthBoundary(new Request(callback), new URL(callback))!
    expect(response.status).toBe(501)
    expect(await response.text()).not.toContain("secret-")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
  })
})
