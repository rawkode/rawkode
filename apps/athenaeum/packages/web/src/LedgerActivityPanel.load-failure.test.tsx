/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DailyStandup } from "./LedgerActivityPanel.js"
import type { DailyStandupController } from "./use-daily-standup.js"

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()) })

describe("DailyStandup lane recovery", () => {
  it("keeps failed ledger and employee lanes distinct and delegates retry to the owner", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    const refresh = vi.fn()
    const standup: DailyStandupController = {
      snapshot: { isToday: true, generation: 5 }, employeeUpdates: { status: "success", publications: [] },
      ledger: { status: "failure" }, isRefreshing: false, refresh
    }
    await act(async () => { root.render(<DailyStandup standup={standup} />) })
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Recorded activity couldn’t be loaded")
    expect(host.textContent).toContain("No published employee updates")
    host.querySelector<HTMLButtonElement>("[aria-label='Refresh recorded work']")?.click()
    expect(refresh).toHaveBeenCalledOnce()
  })
})
