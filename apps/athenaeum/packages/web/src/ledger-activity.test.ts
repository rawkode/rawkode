/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import type { LedgerActivityEntry } from "@athenaeum/domain"
import { summarizeDailyStandup } from "./LedgerActivityPanel.js"

const entry = (actor: LedgerActivityEntry["actor"]): LedgerActivityEntry => ({
  occurredAt: "2026-08-27T09:30:00.000Z",
  type: "createNodeWithIntent",
  actor,
  message: "Create the person entity from the new attendee."
}) as LedgerActivityEntry

describe("daily standup activity summary", () => {
  it("counts each attributable actor without losing the total", () => {
    expect(summarizeDailyStandup([
      entry("you"),
      entry("workspace-member"),
      entry("anonymous"),
      entry("you")
    ])).toEqual({
      total: 4,
      byYou: 2,
      byWorkspaceMembers: 1,
      byAnonymous: 1
    })
  })

  it("returns a zeroed summary for an empty day", () => {
    expect(summarizeDailyStandup([])).toEqual({
      total: 0,
      byYou: 0,
      byWorkspaceMembers: 0,
      byAnonymous: 0
    })
  })

  it("uses named actor detail for newer activity rows", () => {
    const namedEmployee = {
      ...entry("workspace-member"),
      actorDetail: { kind: "employee", label: "Enrichment employee" }
    } as LedgerActivityEntry
    const namedUser = {
      ...entry("workspace-member"),
      actorDetail: { kind: "user", label: "You" }
    } as LedgerActivityEntry
    expect(summarizeDailyStandup([namedEmployee, namedUser])).toEqual({
      total: 2,
      byYou: 1,
      byWorkspaceMembers: 1,
      byAnonymous: 0
    })
  })
})
