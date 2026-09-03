/** @vitest-environment happy-dom */

import { describe, expect, it } from "vitest"
import { dailyNotePageFormatPresentation } from "./DailyNote.js"

describe("daily note page format presentation", () => {
  it("labels Loro pages as the authoritative format", () => {
    expect(dailyNotePageFormatPresentation("loro-v1")).toEqual({
      label: "Loro",
      description: "Loro is authoritative for this page.",
      tone: "authoritative"
    })
  })

  it("makes the explicit legacy compatibility lane visible", () => {
    expect(dailyNotePageFormatPresentation("automerge-v1")).toEqual({
      label: "Legacy Automerge",
      description: "This page is still using the legacy Automerge compatibility lane.",
      tone: "legacy"
    })
  })
})
