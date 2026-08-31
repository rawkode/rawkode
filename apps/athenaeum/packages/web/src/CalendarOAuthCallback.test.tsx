/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CalendarOAuthCallback } from "./CalendarOAuthCallback.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => { root.render(<CalendarOAuthCallback />); await Promise.resolve() })
  return host
}

beforeEach(() => { window.history.replaceState(null, "", "/oauth/google-calendar/callback?code=private-code&state=private-state") })
afterEach(() => {
  for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() }
  window.history.replaceState(null, "", "/")
})

describe("CalendarOAuthCallback", () => {
  it("drops provider query data and offers only a generic return", async () => {
    const host = await mount()
    expect(host.textContent).toContain("authorization was returned to Athenaeum")
    expect(host.textContent).not.toContain("private-code")
    expect(host.textContent).not.toContain("private-state")
    expect(window.location.search).toBe("")
    expect([...host.querySelectorAll("button")]).toHaveLength(1)
  })
})
