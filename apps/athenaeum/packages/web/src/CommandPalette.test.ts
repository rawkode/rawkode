/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import { EntityId, SearchResultEntry } from "@athenaeum/domain"
import { dailyNoteCommandForQuery, PALETTE_COMMANDS, paletteEntriesFor, paletteResultKind } from "./CommandPalette.js"
import { dailyNoteIdForDate, localDateStamp } from "./daily-note-id.js"

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

  it("resolves exact relative and ISO date commands in local civil time", () => {
    const referenceDate = new Date(2026, 0, 1, 23, 30)

    expect(dailyNoteCommandForQuery(" TODAY ", referenceDate)).toMatchObject({
      dateStamp: "2026-01-01",
      to: "/notes",
      label: "Today · 1 Jan 2026"
    })
    expect(dailyNoteCommandForQuery("2026-01-01", referenceDate)).toMatchObject({
      dateStamp: "2026-01-01",
      to: "/notes",
      label: "Daily note · 1 Jan 2026"
    })
    expect(dailyNoteCommandForQuery("yesterday", referenceDate)).toMatchObject({
      dateStamp: "2025-12-31",
      to: "/notes?date=2025-12-31",
      label: "Yesterday · 31 Dec 2025"
    })
    expect(dailyNoteCommandForQuery("tomorrow", referenceDate)).toMatchObject({
      dateStamp: "2026-01-02",
      to: "/notes?date=2026-01-02",
      label: "Tomorrow · 2 Jan 2026"
    })
    expect(dailyNoteCommandForQuery("2028-02-29", referenceDate)).toMatchObject({
      dateStamp: "2028-02-29",
      to: "/notes?date=2028-02-29",
      label: "Daily note · 29 Feb 2028"
    })
    expect(localDateStamp(referenceDate)).toBe("2026-01-01")
  })

  it("rejects non-exact or impossible date queries", () => {
    const referenceDate = new Date(2026, 2, 28, 23, 30)

    expect(dailyNoteCommandForQuery("today planning", referenceDate)).toBeUndefined()
    expect(dailyNoteCommandForQuery("2026-02-29", referenceDate)).toBeUndefined()
    expect(dailyNoteCommandForQuery("2026-02-31", referenceDate)).toBeUndefined()
    expect(dailyNoteCommandForQuery("2026-13-01", referenceDate)).toBeUndefined()
    // Relative commands use civil-day shifting, so the result is stable across a DST boundary.
    expect(dailyNoteCommandForQuery("tomorrow", referenceDate)?.dateStamp).toBe("2026-03-29")
  })

  it("puts an exact date action ahead of recall and suppresses duplicate Today", () => {
    const result = new SearchResultEntry({ nodeId: EntityId.make(nodeId), title: "Today planning", snippet: "A matching note" })
    const entries = paletteEntriesFor("today", [result], new Date(2026, 7, 30, 12))

    expect(entries.map((entry) => entry.kind)).toEqual(["daily-note", "result"])
    expect(entries[0]).toMatchObject({ kind: "daily-note", command: { to: "/notes", dateStamp: "2026-08-30" } })
    expect(entries[1]).toEqual({ kind: "result", result })
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
