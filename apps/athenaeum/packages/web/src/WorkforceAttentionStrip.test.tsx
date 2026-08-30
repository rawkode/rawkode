/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { EntityId, type StandupPublication } from "@athenaeum/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkforceAttentionStrip } from "./WorkforceAttentionStrip.js"

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()) })

const publication = (resultKind: StandupPublication["resultKind"], companionStatus: StandupPublication["companionStatus"] = "verified-original"): StandupPublication => ({
  id: EntityId.make("00000000-0000-4000-8000-000000000121"), civilDate: "2026-08-30",
  microEmployeeLabel: "Executive assistant", jobLabel: "Review calendar", workflowLabel: "private workflow", scheduleLabel: "private schedule",
  microEmployee: { kind: "microEmployee", id: "employee-private", version: "1" }, job: { kind: "job", id: "job-private", version: "1" }, workflow: { kind: "workflow", id: "workflow-private", version: "1" }, schedule: { kind: "schedule", id: "schedule-private", version: "1" }, councilRefs: [],
  originalText: "private original report", publishedAt: "2026-08-30T08:00:00.000Z" as StandupPublication["publishedAt"], childNodeId: EntityId.make("00000000-0000-4000-8000-000000000122"), companionStatus, resultKind
})

describe("WorkforceAttentionStrip", () => {
  it("renders only attention metadata and safe companion navigation", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(<MemoryRouter><WorkforceAttentionStrip state={{ status: "success", publications: [publication("completed"), publication("blocked"), { ...publication("failed", "missing"), id: EntityId.make("00000000-0000-4000-8000-000000000123") }] }} onRetry={vi.fn()} /></MemoryRouter>))
    expect(host.textContent).toContain("2 employee updates need attention")
    expect(host.textContent).toContain("Executive assistant · Review calendar")
    expect(host.textContent).not.toContain("private original report")
    expect(host.textContent).not.toContain("private workflow")
    expect(host.textContent).not.toContain("private schedule")
    expect(host.querySelectorAll("a[href^='/node/']")).toHaveLength(1)
  })

  it("stays absent while loading and gives failure a safe retry", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.push(root); const retry = vi.fn()
    await act(async () => root.render(<MemoryRouter><WorkforceAttentionStrip state={{ status: "loading" }} onRetry={retry} /></MemoryRouter>))
    expect(host.textContent).toBe("")
    await act(async () => root.render(<MemoryRouter><WorkforceAttentionStrip state={{ status: "failure" }} onRetry={retry} /></MemoryRouter>))
    expect(host.textContent).toContain("Employee updates couldn’t be loaded")
    host.querySelector("button")?.click(); expect(retry).toHaveBeenCalledOnce()
  })
})
