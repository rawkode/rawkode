/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { LedgerActivityEntry } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DailyStandupController } from "./use-daily-standup.js"

const queryStateMock = vi.hoisted(() => ({
  entries: [] as Array<LedgerActivityEntry>
}))

import { DAILY_STANDUP_FETCH_LIMIT, DailyStandup } from "./LedgerActivityPanel.js"

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
    const standup: DailyStandupController = {
      snapshot: { isToday: true, generation: 1 }, employeeUpdates: { status: "idle" },
      ledger: { status: "success", value: queryStateMock.entries }, isRefreshing: false, refresh: () => undefined
    }
    root.render(<DailyStandup standup={standup} />)
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

    expect(host.querySelector(".daily-standup-subdocument")?.getAttribute("aria-labelledby")).toBe("daily-standup-title")
    expect(host.querySelector("#daily-standup-title")?.textContent).toBe("Daily standup")
    expect(host.querySelector(".ledger-activity-kind")?.textContent).toBe("Prepared a meeting in the daily note")
    expect(host.querySelector(".ledger-activity-actor")?.textContent).toBe("Workspace member")
    expect(host.querySelector(".ledger-activity-reason p")?.textContent).toBe("Prepare the planning meeting in the daily note.")
    expect(host.textContent).not.toContain("prepareMeetingInDailyNote")
  })

  it("renders named employees and only offers a valid node target", async () => {
    queryStateMock.entries = [{
      occurredAt: "2026-08-28T09:30:00.000Z",
      type: "commitLoroPageContent",
      actor: "workspace-member",
      actorDetail: { kind: "employee", label: "Executive Assistant" },
      target: { kind: "node", id: "00000000-0000-4000-8000-000000000001" },
      message: "Capture the meeting outcome."
    } as unknown as LedgerActivityEntry]
    const host = await mount()
    expect(host.querySelector(".ledger-activity-actor")?.textContent).toBe("Executive Assistant")
    expect(host.querySelector(".ledger-activity-kind")?.textContent).toBe("Updated a note")
    expect(host.querySelector<HTMLAnchorElement>(".ledger-activity-target")?.getAttribute("href")).toBe("/node/00000000-0000-4000-8000-000000000001")
  })

  it("links a Supertag schema change back to the Supertags manager", async () => {
    queryStateMock.entries = [{
      occurredAt: "2026-08-28T09:30:00.000Z",
      type: "updateTag",
      actor: "you",
      target: { kind: "tag", id: "00000000-0000-4000-8000-000000000002" },
      message: "Updated a Supertag definition."
    } as unknown as LedgerActivityEntry]
    const host = await mount()
    expect(host.querySelector<HTMLAnchorElement>(".ledger-activity-target")?.getAttribute("href")).toBe("/supertags")
    expect(host.querySelector(".ledger-activity-target")?.textContent).toBe("Open affected Supertag")
  })

  it("falls back to the legacy actor and hides malformed optional target data", async () => {
    queryStateMock.entries = [{
      occurredAt: "2026-08-28T09:30:00.000Z",
      type: "ensureLoroPage",
      actor: "workspace-member",
      actorDetail: { kind: "unknown", label: "Invented identity" },
      target: { kind: "node", id: "bad" },
      message: "Prepare the note."
    } as unknown as LedgerActivityEntry]
    const host = await mount()
    expect(host.querySelector(".ledger-activity-actor")?.textContent).toBe("Workspace member")
    expect(host.querySelector(".ledger-activity-target")).toBeNull()
  })

  it("fetches the supported recent window but progressively discloses entries beyond the calm default", async () => {
    expect(DAILY_STANDUP_FETCH_LIMIT).toBe(20)
    queryStateMock.entries = Array.from({ length: 9 }, (_, index) => ({
      occurredAt: `2026-08-28T09:${String(index).padStart(2, "0")}:00.000Z`,
      type: "createNodeWithIntent",
      actor: "workspace-member",
      message: `Recorded change ${index + 1}`
    } as LedgerActivityEntry))

    const host = await mount()
    const disclosure = () => host.querySelector<HTMLButtonElement>(".ledger-activity-disclosure")

    expect(host.querySelectorAll(".ledger-activity-entry")).toHaveLength(8)
    expect(host.querySelector(".ledger-activity-summary")?.textContent).toContain("9 changes")
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("false")
    expect(disclosure()?.textContent).toBe("Show 1 more recorded change")

    await act(async () => { disclosure()?.click(); await flush() })
    expect(host.querySelectorAll(".ledger-activity-entry")).toHaveLength(9)
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("true")
    expect(disclosure()?.textContent).toBe("Show fewer recorded changes")

    await act(async () => { disclosure()?.click(); await flush() })
    expect(host.querySelectorAll(".ledger-activity-entry")).toHaveLength(8)
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("false")
  })

  it("renders all retrieved changes without a disclosure control when the result fits the default", async () => {
    queryStateMock.entries = Array.from({ length: 8 }, (_, index) => ({
      occurredAt: `2026-08-28T10:${String(index).padStart(2, "0")}:00.000Z`,
      type: "createNodeWithIntent",
      actor: "workspace-member",
      message: `Recorded change ${index + 1}`
    } as LedgerActivityEntry))

    const host = await mount()
    expect(host.querySelectorAll(".ledger-activity-entry")).toHaveLength(8)
    expect(host.querySelector(".ledger-activity-disclosure")).toBeNull()
  })
})
