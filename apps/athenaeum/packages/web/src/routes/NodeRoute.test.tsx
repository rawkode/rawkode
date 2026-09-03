/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

const useEffectQueryMock = vi.hoisted(() => vi.fn())

vi.mock("../use-effect-query.js", () => ({ useEffectQuery: useEffectQueryMock }))

import { NodeRoute } from "./NodeRoute.js"

const canonicalDailyNodeId = "00000000-0000-4000-8000-000020260827"
const impossibleDailyNodeId = "00000000-0000-4000-8000-000020260231"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []

function LocationProbe() {
  const location = useLocation()
  return <output data-location>{location.pathname}{location.search}</output>
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (nodeId: string) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/node/${nodeId}`]}>
        <Routes>
          <Route path="node/:nodeId" element={<NodeRoute />} />
          <Route path="notes" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    )
    await flush()
  })
  return host
}

afterEach(() => {
  useEffectQueryMock.mockReset()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
})

describe("NodeRoute daily-note retrieval", () => {
  it("redirects a canonical daily id into its date-addressed Loro editor before legacy page reads", async () => {
    const host = await mount(canonicalDailyNodeId)

    expect(host.querySelector("[data-location]")?.textContent).toBe("/notes?date=2026-08-27")
    expect(useEffectQueryMock).not.toHaveBeenCalled()
  })

  it("keeps an impossible reserved-family date on the generic node route", async () => {
    useEffectQueryMock.mockReturnValue({ status: "loading" })
    const host = await mount(impossibleDailyNodeId)

    expect(host.querySelector("[data-location]")).toBeNull()
    expect(host.textContent).toContain("Loading node…")
    expect(useEffectQueryMock).toHaveBeenCalledTimes(2)
  })
})
