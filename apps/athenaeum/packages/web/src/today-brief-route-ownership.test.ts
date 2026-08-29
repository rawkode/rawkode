import { describe, expect, it } from "vitest"
import notesRouteSource from "./routes/NotesRoute.tsx?raw"
import calendarRouteSource from "./routes/CalendarRoute.tsx?raw"
import dailyNoteSource from "./DailyNote.tsx?raw"
import ledgerActivitySource from "./LedgerActivityPanel.tsx?raw"
import todayBriefSource from "./TodayBrief.tsx?raw"

/** Source ownership tests care about rendered JSX, not prose comments or import-specifier order. */
const renderedRouteSource = (source: string): string => {
  // Route hooks commonly return cleanup functions before the component's JSX return. The final
  // `return (` is the route body we are asserting about.
  const renderStart = source.lastIndexOf("return (")
  return renderStart === -1 ? "" : source.slice(renderStart)
}

const todayBriefMounts = (source: string): number => (source.match(/<TodayBrief(?:\s[^>]*)?\s*\/>/g) ?? []).length

describe("Today Brief route ownership", () => {
  it("mounts exactly one brief in NotesRoute and none in CalendarRoute", () => {
    expect(todayBriefMounts(renderedRouteSource(notesRouteSource))).toBe(1)

    expect(todayBriefMounts(renderedRouteSource(calendarRouteSource))).toBe(0)
  })

  it("makes the daily note the route's primary document before its context aside", () => {
    expect(notesRouteSource).not.toContain('className="sr-only"')
    expect(notesRouteSource).toContain('className="notes-layout"')
    expect(notesRouteSource).toContain('todayBriefTargetId={isToday ? "today-brief" : undefined}')
    expect(notesRouteSource).toContain('id={isToday ? "today-brief" : undefined}')
    const renderedNotesRoute = renderedRouteSource(notesRouteSource)
    expect(renderedNotesRoute.indexOf("<DailyNote")).toBeLessThan(renderedNotesRoute.indexOf("<TodayBrief"))
    expect(dailyNoteSource.match(/<h1\b/g)).toHaveLength(1)
    expect(dailyNoteSource).toContain('aria-label={`Daily note for ${fullDateLabel}`}')
    expect(dailyNoteSource).toContain('className={`daily-note-canvas daily-note-canvas-${state.status}`}')
    expect(dailyNoteSource).toContain('state.status === "loading"')
    expect(dailyNoteSource).toContain('state.status === "failure"')
    expect(dailyNoteSource).toContain("{isToday && <DailyStandup />}")
    expect(ledgerActivitySource).toContain("export function DailyStandup()")
    expect(notesRouteSource).not.toContain("LedgerActivityPanel")
    expect(todayBriefSource).toContain('<aside id={id} className="today-brief" aria-labelledby="today-brief-title">')
    expect(todayBriefSource).toContain("No events.")
  })

  it("creates new notes directly as Loro while retaining a legacy Automerge read lane", () => {
    expect(dailyNoteSource).toContain("client.createLoroPage(new CreateLoroPageInput")
    expect(dailyNoteSource).not.toContain("client.createPage(new CreatePageInput")
    expect(dailyNoteSource).not.toContain("client.activateLoroPage(")
    expect(dailyNoteSource).toContain('() => import("./legacy-daily-note.js")')
    expect(dailyNoteSource).toContain("legacy.resolveLegacyDailyNote(client, workspaceId, nodeId, legacyCell)")
  })

})
