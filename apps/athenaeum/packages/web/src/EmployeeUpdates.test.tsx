/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { EntityId, type StandupPublication } from "@athenaeum/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EmployeeUpdates,
  partitionEmployeeUpdates,
  workforceAttentionPresentation,
  type EmployeeUpdatePublication,
  type EmployeeUpdateResultKind,
  type EmployeeUpdatesState,
} from "./EmployeeUpdates.js"

const childNodeId = EntityId.make("00000000-0000-4000-8000-000000000011")
const publication: EmployeeUpdatePublication = {
  id: EntityId.make("00000000-0000-4000-8000-000000000010"), civilDate: "2026-08-28",
  microEmployeeLabel: "Researcher", jobLabel: "Daily scan", workflowLabel: "Morning", scheduleLabel: "Weekdays",
  microEmployee: { kind: "microEmployee" as const, id: "researcher", version: "1" },
  job: { kind: "job" as const, id: "scan", version: "1" }, workflow: { kind: "workflow" as const, id: "morning", version: "1" },
  schedule: { kind: "schedule" as const, id: "weekdays", version: "1" }, councilRefs: [], publishedAt: "2026-08-28T08:00:00.000Z" as StandupPublication["publishedAt"],
  originalText: "Finished line one\n<script>alert('x')</script>", childNodeId, companionStatus: "verified-original" as const
}

const makePublication = (
  suffix: string,
  resultKind?: EmployeeUpdateResultKind,
  companionStatus: EmployeeUpdatePublication["companionStatus"] = "verified-original",
): EmployeeUpdatePublication => ({
  ...publication,
  id: EntityId.make(`00000000-0000-4000-8000-${suffix.padStart(12, "0")}`),
  childNodeId: EntityId.make(`00000000-0000-4000-8000-1${suffix.padStart(11, "0")}`),
  originalText: `Update ${suffix}`,
  resultKind,
  companionStatus,
})

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const mount = async (state: EmployeeUpdatesState, onRetry?: () => void) => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host); roots.push({ root, host })
  await act(async () => { root.render(<MemoryRouter><EmployeeUpdates state={state} onRetry={onRetry} /></MemoryRouter>) })
  return host
}

afterEach(() => { for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() }; vi.restoreAllMocks() })

describe("EmployeeUpdates presentation", () => {
  it("projects only capped blocked or failed metadata into the writing-surface attention contract", () => {
    const attention = workforceAttentionPresentation({
      status: "success",
      publications: [
        { ...makePublication("040", "completed"), originalText: "never project this", workflowLabel: "private workflow" },
        { ...makePublication("041", "blocked"), microEmployeeLabel: "Calendar concierge", jobLabel: "Resolve attendee" },
        { ...makePublication("042", "failed", "missing"), microEmployeeLabel: "Researcher", jobLabel: "Enrich profile" },
        { ...makePublication("043", "failed"), microEmployeeLabel: "Reviewer", jobLabel: "Check report" },
        { ...makePublication("044", "blocked"), microEmployeeLabel: "Later", jobLabel: "Later job" }
      ]
    }, 2)
    expect(attention).toEqual({
      kind: "attention",
      totalAttentionCount: 4,
      disclosures: [
        { outcome: "Blocked", employee: "Calendar concierge", job: "Resolve attendee", destination: `/node/${makePublication("041", "blocked").childNodeId}` },
        { outcome: "Failed", employee: "Researcher", job: "Enrich profile" }
      ],
      remainderCount: 2
    })
    expect(JSON.stringify(attention)).not.toContain("never project this")
    expect(JSON.stringify(attention)).not.toContain("private workflow")
    expect(workforceAttentionPresentation({ status: "success", publications: [makePublication("045")] })).toEqual({ kind: "all-clear", routineCount: 1 })
    expect(workforceAttentionPresentation({ status: "loading" })).toEqual({ kind: "hidden" })
    expect(workforceAttentionPresentation({ status: "failure" })).toEqual({ kind: "failure" })
  })
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
    expect(host.querySelector(".employee-update-outcome")).toBeNull()
  })

  it("stably partitions every outcome while preserving source order and leaving nil unlabeled", async () => {
    const mixed = [
      makePublication("020", "completed"),
      makePublication("021", "blocked"),
      makePublication("022", "failed"),
      makePublication("023", "skipped"),
      makePublication("024"),
    ]
    const partitions = partitionEmployeeUpdates(mixed)
    expect(partitions.needsAttention.map(({ id }) => id)).toEqual([mixed[1]!.id, mixed[2]!.id])
    expect(partitions.updates.map(({ id }) => id)).toEqual([mixed[0]!.id, mixed[3]!.id, mixed[4]!.id])

    const host = await mount({ status: "success", publications: mixed })
    expect(host.querySelector("#employee-updates-attention-title")?.textContent).toBe("Needs attention")
    expect(host.querySelector("#employee-updates-updates-title")?.textContent).toBe("Updates")
    expect(host.querySelectorAll(".employee-updates-list")).toHaveLength(2)
    expect(host.querySelector(".employee-updates-group-attention")?.textContent).toContain("Blocked")
    expect(host.querySelector(".employee-updates-group-attention")?.textContent).toContain("Failed")
    expect(host.querySelector(".employee-updates-group-updates")?.textContent).toContain("Completed")
    expect(host.querySelector(".employee-updates-group-updates")?.textContent).toContain("Skipped")
    expect(host.querySelectorAll(".employee-update-outcome")).toHaveLength(4)

    const attentionTexts = [...host.querySelectorAll(".employee-updates-group-attention .employee-update-text")].map((node) => node.textContent)
    const updateTexts = [...host.querySelectorAll(".employee-updates-group-updates .employee-update-text")].map((node) => node.textContent)
    expect(attentionTexts).toEqual(["Update 021", "Update 022"])
    expect(updateTexts).toEqual(["Update 020", "Update 023", "Update 024"])
  })

  it("keeps loading and failure distinct from a successful empty result", async () => {
    expect((await mount({ status: "loading" })).textContent).toContain("Loading employee updates…")
    const onRetry = vi.fn(); const failed = await mount({ status: "failure" }, onRetry)
    expect(failed.querySelector("[role=alert]")).not.toBeNull()
    expect(failed.textContent).not.toContain("No published employee updates")
    failed.querySelector("button")?.click(); expect(onRetry).toHaveBeenCalledOnce()
    expect((await mount({ status: "success", publications: [] })).textContent).toContain("No published employee updates")
  })

  it("does not offer a dead companion link when the linked page is missing or unavailable", async () => {
    const missing = await mount({ status: "success", publications: [{ ...publication, companionStatus: "missing" }] })
    expect(missing.querySelector("a")).toBeNull()
    const unavailable = await mount({ status: "success", publications: [{ ...publication, companionStatus: "unavailable" }] })
    expect(unavailable.querySelector("a")).toBeNull()
  })

  it("keeps companion status and link policy independent from outcome grouping", async () => {
    const modifiedBlocked = makePublication("030", "blocked", "modified")
    const missingCompleted = makePublication("031", "completed", "missing")
    const host = await mount({ status: "success", publications: [modifiedBlocked, missingCompleted] })

    expect(host.querySelector(".employee-updates-group-attention")?.textContent).toContain("Blocked")
    expect(host.querySelector(".employee-updates-group-attention")?.textContent).toContain("This update may have changed since publication.")
    expect(host.querySelector(".employee-updates-group-attention a")?.getAttribute("href")).toBe(`/node/${modifiedBlocked.childNodeId}`)
    expect(host.querySelector(".employee-updates-group-updates")?.textContent).toContain("Completed")
    expect(host.querySelector(".employee-updates-group-updates")?.textContent).toContain("The companion update is no longer available.")
    expect(host.querySelector(".employee-updates-group-updates a")).toBeNull()
  })
})
