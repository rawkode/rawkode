/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import type { EntityId, LocalDate, PrepareMeetingInDailyNoteOutput } from "@athenaeum/domain"
import { isAuthoritativeMeetingPreparationReload, isMatchingMeetingPreparationReceipt } from "./LoroRichNoteEditor.js"

const node = "00000000-0000-4000-8000-000000000001" as EntityId
const otherNode = "00000000-0000-4000-8000-000000000002" as EntityId
const date = "2026-08-30" as LocalDate
const key = "a".repeat(64)
const receipt = {
  dailyNoteId: node,
  localDate: date,
  occurrenceKey: key,
  status: "created",
  resultSnapshotSha256: key
} as PrepareMeetingInDailyNoteOutput

describe("meeting preparation completion guards", () => {
  it("requires an exact receipt identity", () => {
    expect(isMatchingMeetingPreparationReceipt(receipt, node, date, key)).toBe(true)
    expect(isMatchingMeetingPreparationReceipt({ ...receipt, dailyNoteId: otherNode }, node, date, key)).toBe(false)
    expect(isMatchingMeetingPreparationReceipt({ ...receipt, localDate: "2026-08-31" as LocalDate }, node, date, key)).toBe(false)
    expect(isMatchingMeetingPreparationReceipt({ ...receipt, occurrenceKey: "b".repeat(64) }, node, date, key)).toBe(false)
  })

  it("requires a current clean reload of the same descriptor node before callback or focus", () => {
    expect(isAuthoritativeMeetingPreparationReload({ current: true, clean: true, descriptorNodeId: node, nodeId: node })).toBe(true)
    expect(isAuthoritativeMeetingPreparationReload({ current: false, clean: true, descriptorNodeId: node, nodeId: node })).toBe(false)
    expect(isAuthoritativeMeetingPreparationReload({ current: true, clean: false, descriptorNodeId: node, nodeId: node })).toBe(false)
    expect(isAuthoritativeMeetingPreparationReload({ current: true, clean: true, descriptorNodeId: otherNode, nodeId: node })).toBe(false)
    expect(isAuthoritativeMeetingPreparationReload({ current: true, clean: true, descriptorNodeId: undefined, nodeId: node })).toBe(false)
  })
})
