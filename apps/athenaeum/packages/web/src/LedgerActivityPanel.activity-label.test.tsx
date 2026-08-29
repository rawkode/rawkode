/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { LedgerActivityEntry } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  entries: [] as Array<LedgerActivityEntry>
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: () => ({
    status: "success" as const,
    value: { entries: queryStateMock.entries }
  })
}))

import { DailyStandup } from "./LedgerActivityPanel.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<DailyStandup />)
    await flush()
  })
  return host
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.entries = [{
    occurredAt: "2026-08-28T09:30:00.000Z",
    type: "prepareMeetingInDailyNote",
    actor: "workspace-member",
    message: "Prepare the planning meeting in the daily note."
  } as LedgerActivityEntry]
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("DailyStandup meeting preparation activity", () => {
  it("renders the public meeting-preparation activity with its actor and commit reason", async () => {
    const host = await mount()

    expect(host.querySelector(".ledger-activity-kind")?.textContent).toBe("Prepared a meeting in the daily note")
    expect(host.querySelector(".ledger-activity-actor")?.textContent).toBe("Workspace member")
    expect(host.querySelector(".ledger-activity-reason p")?.textContent).toBe("Prepare the planning meeting in the daily note.")
    expect(host.textContent).not.toContain("prepareMeetingInDailyNote")
  })
})
