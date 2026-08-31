/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import type { EntityId, LocalDate, PrepareMeetingInDailyNoteOutput } from "@athenaeum/domain"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { focusMeetingPreparation, focusMeetingPreparationWhenReady, isAuthoritativeMeetingPreparationReload, isMatchingMeetingPreparationReceipt } from "./LoroRichNoteEditor.js"
import { meetingPreparationMarkerForNode, richTextSchemaAdapter } from "./rich-text/schema.js"

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
  it("emits only a validated presentation marker for a recognized meeting block", () => {
    const node = richTextSchemaAdapter.schema.nodes.unknownBlock.create(
      {
        isAmgBlock: true,
        unknownBlock: { type: "athenaeum-meeting-prep", parents: [], attrs: { schemaVersion: 1, localDate: date, occurrenceKey: key }, isEmbed: false }
      },
      richTextSchemaAdapter.schema.nodes.paragraph.create()
    )
    expect(meetingPreparationMarkerForNode(node)).toEqual({ localDate: date, occurrenceKey: key })
    expect(meetingPreparationMarkerForNode(node.type.create({
      ...node.attrs,
      unknownBlock: { ...node.attrs.unknownBlock, attrs: { schemaVersion: 2, localDate: date, occurrenceKey: key } }
    }))).toBeUndefined()
    expect(meetingPreparationMarkerForNode(node.type.create({
      ...node.attrs,
      unknownBlock: { ...node.attrs.unknownBlock, attrs: { schemaVersion: 1, localDate: date, occurrenceKey: "A".repeat(64) } }
    }))).toBeUndefined()
  })

  it("selects and scrolls the exact occurrence without falling back to arbitrary DOM", () => {
    const host = document.createElement("div")
    document.body.append(host)
    const paragraph = richTextSchemaAdapter.schema.nodes.paragraph
    const doc = richTextSchemaAdapter.schema.nodes.doc.create(null, [
      paragraph.create(null, richTextSchemaAdapter.schema.text("before")),
      richTextSchemaAdapter.schema.nodes.unknownBlock.create(
        {
          isAmgBlock: true,
          unknownBlock: { type: "athenaeum-meeting-prep", parents: [], attrs: { schemaVersion: 1, localDate: date, occurrenceKey: key }, isEmbed: false }
        },
        paragraph.create(null, richTextSchemaAdapter.schema.text("Meeting preparation"))
      )
    ])
    const view = new EditorView(host, { state: EditorState.create({ schema: richTextSchemaAdapter.schema, doc }) })
    const scroll = HTMLElement.prototype.scrollIntoView
    let didScroll = false
    HTMLElement.prototype.scrollIntoView = function () { didScroll = true }
    try {
      expect(focusMeetingPreparation(view, { localDate: date, occurrenceKey: key })).toBe(true)
      expect(didScroll).toBe(true)
      expect(view.state.selection.from).toBeGreaterThan(1)
      expect(focusMeetingPreparation(view, { localDate: date, occurrenceKey: "b".repeat(64) })).toBe(false)
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll
      view.destroy()
      host.remove()
    }
  })

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

  it("waits for a delayed marker mount, but abandons a replaced attachment", async () => {
    let attempts = 0
    const binding = {
      focusMeetingPreparation: () => {
        attempts += 1
        return attempts === 3
      }
    }
    expect(await focusMeetingPreparationWhenReady(binding, { localDate: date, occurrenceKey: key }, () => true, 4)).toBe(true)
    expect(attempts).toBe(3)

    let current = true
    attempts = 0
    const replacedBinding = {
      focusMeetingPreparation: () => {
        attempts += 1
        current = false
        return false
      }
    }
    expect(await focusMeetingPreparationWhenReady(replacedBinding, { localDate: date, occurrenceKey: key }, () => current, 4)).toBe(false)
    expect(attempts).toBe(1)
  })
})
