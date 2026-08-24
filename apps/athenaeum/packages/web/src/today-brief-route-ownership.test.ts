import { describe, expect, it } from "vitest"
import notesRouteSource from "./routes/NotesRoute.tsx?raw"
import calendarRouteSource from "./routes/CalendarRoute.tsx?raw"

const todayBriefMounts = (source: string): number => (source.match(/<TodayBrief\s*\/>/g) ?? []).length

describe("Today Brief route ownership", () => {
  it("mounts exactly one brief in NotesRoute and none in CalendarRoute", () => {
    expect(notesRouteSource).toContain('import { TodayBrief } from "../TodayBrief.js"')
    expect(todayBriefMounts(notesRouteSource)).toBe(1)

    expect(calendarRouteSource).not.toContain("TodayBrief")
    expect(todayBriefMounts(calendarRouteSource)).toBe(0)
  })
})
