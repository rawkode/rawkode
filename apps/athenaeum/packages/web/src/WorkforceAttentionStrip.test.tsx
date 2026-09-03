/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { EntityId, type StandupPublication } from "@athenaeum/domain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkforceAttentionStrip } from "./WorkforceAttentionStrip.js"
import { focusWorkforceAttentionItem, workforceAttentionAnchorId } from "./EmployeeUpdates.js"

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()) })

const publication = (resultKind: StandupPublication["resultKind"], companionStatus: StandupPublication["companionStatus"] = "verified-original"): StandupPublication => ({
  id: EntityId.make("00000000-0000-4000-8000-000000000121"), civilDate: "2026-08-30",
  microEmployeeLabel: "Executive assistant", jobLabel: "Review calendar", workflowLabel: "private workflow", scheduleLabel: "private schedule",
  microEmployee: { kind: "microEmployee", id: "employee-private", version: "1" }, job: { kind: "job", id: "job-private", version: "1" }, workflow: { kind: "workflow", id: "workflow-private", version: "1" }, schedule: { kind: "schedule", id: "schedule-private", version: "1" }, councilRefs: [],
  originalText: "private original report", publishedAt: "2026-08-30T08:00:00.000Z" as StandupPublication["publishedAt"], childNodeId: EntityId.make("00000000-0000-4000-8000-000000000122"), companionStatus, resultKind
})

describe("WorkforceAttentionStrip", () => {
  it("renders only attention metadata and review actions", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(<MemoryRouter><WorkforceAttentionStrip state={{ status: "success", publications: [publication("completed"), publication("blocked"), { ...publication("failed", "missing"), id: EntityId.make("00000000-0000-4000-8000-000000000123") }] }} onRetry={vi.fn()} onReviewItem={vi.fn()} /></MemoryRouter>))
    expect(host.textContent).toContain("2 employee updates need attention")
    expect(host.textContent).toContain("Executive assistant · Review calendar")
    expect(host.textContent).not.toContain("private original report")
    expect(host.textContent).not.toContain("private workflow")
    expect(host.textContent).not.toContain("private schedule")
    expect(host.querySelectorAll("button")).toHaveLength(2)
    expect(host.querySelector<HTMLAnchorElement>("a[href='#daily-standup-title']")?.textContent).toBe("Review standup")
  })

  it("reviews the exact publication without changing the route", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    const review = vi.fn()
    await act(async () => root.render(<MemoryRouter><WorkforceAttentionStrip state={{ status: "success", publications: [publication("blocked", "missing")] }} onRetry={vi.fn()} onReviewItem={review} /></MemoryRouter>))

    host.querySelector<HTMLButtonElement>("button")?.click()
    expect(review).toHaveBeenCalledWith(publication("blocked", "missing").id)
    expect(location.hash).toBe("")
  })

  it("focuses the namespaced lower-row anchor predictably", () => {
    const target = document.createElement("li")
    target.id = workforceAttentionAnchorId(publication("blocked", "missing").id)
    const scrollIntoView = vi.fn()
    const focus = vi.fn()
    Object.assign(target, { scrollIntoView, focus })
    document.body.append(target)

    expect(focusWorkforceAttentionItem(publication("blocked", "missing").id)).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    target.remove()
  })

  it("keeps the all-clear return path in the same daily note", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(<MemoryRouter><WorkforceAttentionStrip state={{ status: "success", publications: [publication("completed")] }} onRetry={vi.fn()} /></MemoryRouter>))
    expect(host.querySelector<HTMLAnchorElement>("a[href='#daily-standup-title']")?.textContent).toBe("Review standup")
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
