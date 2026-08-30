/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import { EntityId, SearchResultEntry } from "@athenaeum/domain"
import { PALETTE_COMMANDS, paletteEntriesFor, paletteResultKind } from "./CommandPalette.js"
import { dailyNoteIdForDate } from "./daily-note-id.js"

const nodeId = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

describe("command palette entries", () => {
  it("offers the high-frequency destinations before a query is entered", () => {
    const entries = paletteEntriesFor("", [])

    expect(entries).toHaveLength(PALETTE_COMMANDS.length)
    expect(entries[0]).toEqual({ kind: "command", command: PALETTE_COMMANDS[0] })
    expect(entries.every((entry) => entry.kind === "command")).toBe(true)
  })

  it("puts recalled records before matching destinations", () => {
    const result = new SearchResultEntry({ nodeId: EntityId.make(nodeId), title: "Project Delta", snippet: "A project note" })
    const entries = paletteEntriesFor("gadget", [result])

    expect(entries[0]).toEqual({ kind: "result", result })
    expect(entries.at(-1)).toEqual({ kind: "command", command: PALETTE_COMMANDS.find((command) => command.id === "apps") })
  })

  it("does not surface unrelated destinations for a focused query", () => {
    const entries = paletteEntriesFor("calendar", [])

    expect(entries).toEqual([{ kind: "command", command: PALETTE_COMMANDS[2] }])
  })

  it("describes records from their stable identity rather than their title", () => {
    const dailyNote = new SearchResultEntry({
      nodeId: dailyNoteIdForDate(new Date(2026, 7, 22)),
      title: "Untitled",
      snippet: "Daily content"
    })
    const record = new SearchResultEntry({ nodeId: EntityId.make(nodeId), title: "Daily Note — 2026-08-22", snippet: "Imported record" })

    expect(paletteResultKind(dailyNote)).toBe("Daily note · 22 Aug 2026")
    expect(paletteResultKind(record)).toBe("Record")
  })
})
