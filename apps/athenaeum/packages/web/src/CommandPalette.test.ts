/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import { EntityId, SearchResultEntry } from "@athenaeum/domain"
import { PALETTE_COMMANDS, paletteEntriesFor } from "./CommandPalette.js"

const nodeId = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

describe("command palette entries", () => {
  it("offers the high-frequency destinations before a query is entered", () => {
    const entries = paletteEntriesFor("", [])

    expect(entries).toHaveLength(PALETTE_COMMANDS.length)
    expect(entries[0]).toEqual({ kind: "command", command: PALETTE_COMMANDS[0] })
    expect(entries.every((entry) => entry.kind === "command")).toBe(true)
  })

  it("keeps matching destinations alongside full-text note results", () => {
    const result = new SearchResultEntry({ nodeId: EntityId.make(nodeId), title: "Project Delta", snippet: "A project note" })
    const entries = paletteEntriesFor("gadget", [result])

    expect(entries[0]).toEqual({ kind: "command", command: PALETTE_COMMANDS.find((command) => command.id === "apps") })
    expect(entries.at(-1)).toEqual({ kind: "result", result })
  })

  it("does not surface unrelated destinations for a focused query", () => {
    const entries = paletteEntriesFor("calendar", [])

    expect(entries).toEqual([{ kind: "command", command: PALETTE_COMMANDS[2] }])
  })
})
