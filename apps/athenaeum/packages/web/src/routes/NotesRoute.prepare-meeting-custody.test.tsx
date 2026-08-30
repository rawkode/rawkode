/** @vitest-environment happy-dom */

import { StrictMode, type ReactNode } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PrepareMeetingHandler } from "../LoroRichNoteEditor.js"
import type { TodayBriefEvent, TodayBriefPrepareMeeting } from "../TodayBrief.js"

type DailyNoteProps = {
  readonly onNavigateDate: (stamp: string) => void
  readonly onPrepareMeetingReady?: (prepare: PrepareMeetingHandler | undefined) => void
  readonly dailyContext?: ReactNode
}
type TodayBriefProps = { readonly onPrepareMeeting?: TodayBriefPrepareMeeting }

const rendered = vi.hoisted(() => ({
  dailyNotes: [] as DailyNoteProps[],
  todayBriefs: [] as TodayBriefProps[],
  search: "date=2026-08-27"
}))

vi.mock("react-router", () => ({
  useNavigate: () => () => undefined,
  useSearchParams: () => [
    new URLSearchParams(rendered.search),
    (next: Record<string, string>) => { rendered.search = new URLSearchParams(next).toString() }
  ]
}))

vi.mock("../DailyNote.js", () => ({
  DailyNote: (props: DailyNoteProps) => {
    rendered.dailyNotes.push(props)
    return props.dailyContext ?? null
  }
}))
vi.mock("../TodayBrief.js", () => ({
  TodayBrief: (props: TodayBriefProps) => {
    rendered.todayBriefs.push(props)
    return null
  }
}))

import { NotesRoute } from "./NotesRoute.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}
const latest = <Value,>(values: readonly Value[]): Value => values.at(-1) as Value

const renderRoute = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<StrictMode><NotesRoute /></StrictMode>)
    await flush()
  })
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  rendered.dailyNotes = []
  rendered.todayBriefs = []
  rendered.search = "date=2026-08-27"
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("NotesRoute prepare-meeting custody", () => {
  it("fences preparation availability and retained callbacks to their exact routed day generation", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    await renderRoute(root)

    const oldRegistration = latest(rendered.dailyNotes).onPrepareMeetingReady
    const oldHandler = vi.fn<PrepareMeetingHandler>().mockResolvedValue(undefined as never)
    await act(async () => {
      oldRegistration?.(oldHandler)
      await flush()
    })
    const oldPrepare = latest(rendered.todayBriefs).onPrepareMeeting
    expect(oldPrepare).toBeDefined()

    await act(async () => {
      latest(rendered.dailyNotes).onNavigateDate("2026-08-28")
      await expect(oldPrepare?.({ title: "Planning", occurrenceKey: "occurrence-1" } as TodayBriefEvent, "2026-08-28" as never, "Europe/London" as never)).rejects.toThrow("not ready")
      await flush()
    })
    await renderRoute(root)
    expect(latest(rendered.todayBriefs).onPrepareMeeting).toBeUndefined()
    const newRegistration = latest(rendered.dailyNotes).onPrepareMeetingReady
    const newHandler = vi.fn<PrepareMeetingHandler>().mockResolvedValue(undefined as never)
    await act(async () => {
      newRegistration?.(newHandler)
      await flush()
    })
    const currentPrepare = latest(rendered.todayBriefs).onPrepareMeeting
    expect(currentPrepare).toBeDefined()

    await act(async () => {
      oldRegistration?.(undefined)
      await flush()
    })
    expect(latest(rendered.todayBriefs).onPrepareMeeting).toBe(currentPrepare)

    const event = { title: "Planning", occurrenceKey: "occurrence-1" } as TodayBriefEvent
    await expect(oldPrepare?.(event, "2026-08-28" as never, "Europe/London" as never)).rejects.toThrow("not ready")
    expect(oldHandler).not.toHaveBeenCalled()
    expect(newHandler).not.toHaveBeenCalled()

    await currentPrepare?.(event, "2026-08-28" as never, "Europe/London" as never)
    expect(newHandler).toHaveBeenCalledWith({
      localDate: "2026-08-28",
      timeZone: "Europe/London",
      occurrenceKey: "occurrence-1",
      commitMessage: "Prepare “Planning” in the daily note."
    })

    rendered.search = "date=2026-08-29"
    await renderRoute(root)
    expect(latest(rendered.todayBriefs).onPrepareMeeting).toBeUndefined()
    await expect(currentPrepare?.(event, "2026-08-29" as never, "Europe/London" as never)).rejects.toThrow("not ready")
    expect(newHandler).toHaveBeenCalledTimes(1)

    const historyRegistration = latest(rendered.dailyNotes).onPrepareMeetingReady
    await act(async () => {
      historyRegistration?.(newHandler)
      await flush()
    })
    rendered.search = "date=2026-08-28"
    await renderRoute(root)
    const returnedRegistration = latest(rendered.dailyNotes).onPrepareMeetingReady
    await act(async () => {
      newRegistration?.(newHandler)
      newRegistration?.(undefined)
      await flush()
    })
    expect(latest(rendered.todayBriefs).onPrepareMeeting).toBeUndefined()
    await act(async () => {
      returnedRegistration?.(newHandler)
      await flush()
    })
    expect(latest(rendered.todayBriefs).onPrepareMeeting).toBeDefined()
  })
})
