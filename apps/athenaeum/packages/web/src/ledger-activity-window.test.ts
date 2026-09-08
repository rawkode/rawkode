import { describe, expect, it } from "vitest"
import { dailyStandupWindow } from "./daily-standup-window.js"

describe("dailyStandupWindow", () => {
  it("returns the browser-local calendar day as a half-open instant window", () => {
    const now = new Date(2026, 7, 27, 14, 30, 0)
    const window = dailyStandupWindow(now)

    expect(window.from).toBe(new Date(2026, 7, 27, 0, 0, 0).toISOString())
    expect(window.to).toBe(new Date(2026, 7, 28, 0, 0, 0).toISOString())
  })
})
