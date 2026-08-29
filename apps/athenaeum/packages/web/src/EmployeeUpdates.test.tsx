/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { EntityId, type StandupPublication } from "@athenaeum/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EmployeeUpdates, type EmployeeUpdatesState } from "./EmployeeUpdates.js"

const childNodeId = EntityId.make("00000000-0000-4000-8000-000000000011")
const publication: StandupPublication = {
  id: EntityId.make("00000000-0000-4000-8000-000000000010"), civilDate: "2026-08-28",
  microEmployeeLabel: "Researcher", jobLabel: "Daily scan", workflowLabel: "Morning", scheduleLabel: "Weekdays",
  microEmployee: { kind: "microEmployee" as const, id: "researcher", version: "1" },
  job: { kind: "job" as const, id: "scan", version: "1" }, workflow: { kind: "workflow" as const, id: "morning", version: "1" },
  schedule: { kind: "schedule" as const, id: "weekdays", version: "1" }, councilRefs: [], publishedAt: "2026-08-28T08:00:00.000Z" as StandupPublication["publishedAt"],
  originalText: "Finished line one\n<script>alert('x')</script>", childNodeId, companionStatus: "verified-original" as const
}

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const mount = async (state: EmployeeUpdatesState, onRetry?: () => void) => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host); roots.push({ root, host })
  await act(async () => { root.render(<MemoryRouter><EmployeeUpdates state={state} onRetry={onRetry} /></MemoryRouter>) })
  return host
}

afterEach(() => { for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() }; vi.restoreAllMocks() })

describe("EmployeeUpdates presentation", () => {
  it("renders supplied original multiline text safely with labels, status, and node link", async () => {
    const host = await mount({ status: "success", publications: [publication] })
    expect(host.querySelector(".employee-update-text")?.textContent).toContain("\n<script>alert('x')</script>")
    expect(host.querySelectorAll("script")).toHaveLength(0)
    expect(host.textContent).toContain("Employee: Researcher")
    expect(host.textContent).toContain("Job: Daily scan")
    expect(host.textContent).toContain("Workflow: Morning")
    expect(host.textContent).toContain("Schedule: Weekdays")
    expect(host.textContent).toContain("Original update verified.")
    expect(host.querySelector("a")?.getAttribute("href")).toBe(`/node/${childNodeId}`)
  })

  it("keeps loading and failure distinct from a successful empty result", async () => {
    expect((await mount({ status: "loading" })).textContent).toContain("Loading employee updates…")
    const onRetry = vi.fn(); const failed = await mount({ status: "failure" }, onRetry)
    expect(failed.querySelector("[role=alert]")).not.toBeNull()
    expect(failed.textContent).not.toContain("No published employee updates")
    failed.querySelector("button")?.click(); expect(onRetry).toHaveBeenCalledOnce()
    expect((await mount({ status: "success", publications: [] })).textContent).toContain("No published employee updates")
  })
})
