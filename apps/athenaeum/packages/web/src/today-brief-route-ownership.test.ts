import { describe, expect, it } from "vitest"
import notesRouteSource from "./routes/NotesRoute.tsx?raw"
import calendarRouteSource from "./routes/CalendarRoute.tsx?raw"
import dailyNoteSource from "./DailyNote.tsx?raw"
import ledgerActivitySource from "./LedgerActivityPanel.tsx?raw"
import todayBriefSource from "./TodayBrief.tsx?raw"
import appCss from "./app.css?raw"

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
    expect(dailyNoteSource).toContain("const standup = useDailyStandup({")
    expect(dailyNoteSource).toContain("<DailyStandup standup={standup} />")
    expect(ledgerActivitySource).toContain("export function DailyStandup({ standup = emptyStandup }")
    expect(notesRouteSource).not.toContain("LedgerActivityPanel")
    expect(todayBriefSource).toContain('<aside id={id} className="today-brief" aria-labelledby="today-brief-title">')
    expect(todayBriefSource).toContain("No events.")
  })

  it("creates new notes as Loro and freezes legacy pages behind a server projection", () => {
    expect(dailyNoteSource).toContain("client.createLoroPage(new CreateLoroPageInput")
    expect(dailyNoteSource).not.toContain("client.createPage(new CreatePageInput")
    expect(dailyNoteSource).not.toContain("client.activateLoroPage(")
    expect(dailyNoteSource).toContain("client.getLegacyPageProjection(")
    expect(dailyNoteSource).toContain("client.migrateLegacyPage(")
    expect(dailyNoteSource).not.toContain('import("./legacy-daily-note.js")')
    expect(dailyNoteSource).not.toContain("resolveLegacyDailyNote")
    expect(dailyNoteSource).not.toContain("startPageSync")
    expect(dailyNoteSource).not.toContain("pageSyncMessage")
    expect(dailyNoteSource).not.toContain("applyPageEdit")
  })

  it("owns the Today companion layout with a measured, non-sticky collapse contract", () => {
    expect(appCss).toContain(".daily-note-workspace")
    expect(appCss).toContain("@container notes-route (min-width: 64rem)")
    expect(appCss).toContain("grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem)")
    expect(appCss).not.toContain("display: contents")

    const wideLayoutStart = appCss.indexOf("@container notes-route (min-width: 64rem)")
    const wideLayoutEnd = appCss.indexOf("\n.today-brief-events", wideLayoutStart)
    const wideLayout = appCss.slice(wideLayoutStart, wideLayoutEnd === -1 ? undefined : wideLayoutEnd)
    expect(wideLayout).not.toContain("position: sticky")
    expect(wideLayout).not.toContain("max-height")
    expect(wideLayout).not.toContain("overflow-y")
  })

})
