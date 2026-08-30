/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type TodayBriefProps = {
  readonly onOpenPerson?: (personNodeId: string) => void
}

const rendered = vi.hoisted(() => ({
  todayBriefs: [] as TodayBriefProps[],
  navigate: vi.fn(),
  search: ""
}))

vi.mock("react-router", () => ({
  useNavigate: () => rendered.navigate,
  useSearchParams: () => [
    new URLSearchParams(rendered.search),
    (next: Record<string, string>) => { rendered.search = new URLSearchParams(next).toString() }
  ]
}))

vi.mock("../DailyNote.js", () => ({
  DailyNote: () => null
}))

vi.mock("../TodayBrief.js", () => ({
  TodayBrief: (props: TodayBriefProps) => {
    rendered.todayBriefs.push(props)
    return null
  }
}))

import { NotesRoute } from "./NotesRoute.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const latest = <Value,>(values: readonly Value[]): Value => values.at(-1) as Value

beforeEach(() => {
  rendered.todayBriefs = []
  rendered.navigate.mockReset()
  rendered.search = "date=2026-08-27"
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
})

describe("NotesRoute person navigation", () => {
  it("routes only the server-validated person handle to the existing node route", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })

    await act(async () => {
      root.render(<NotesRoute />)
      await Promise.resolve()
    })

    const personNodeId = "550e8400-e29b-41d4-a716-446655440000"
    await act(async () => {
      latest(rendered.todayBriefs).onOpenPerson?.(personNodeId)
    })

    expect(rendered.navigate).toHaveBeenCalledOnce()
    expect(rendered.navigate).toHaveBeenCalledWith(`/node/${personNodeId}`)
  })
})
