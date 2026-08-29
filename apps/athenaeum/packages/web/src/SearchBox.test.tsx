/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EntityId, SearchNodesOutput, SearchResultEntry } from "@athenaeum/domain"

const queryStateMock = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock("./use-effect-query.js", () => ({ useEffectQuery: () => queryStateMock.current }))

import { SearchBox } from "./SearchBox.js"

const firstNodeId = EntityId.make("00000000-0000-4000-8000-000000000011")
const secondNodeId = EntityId.make("00000000-0000-4000-8000-000000000012")
const results = [
  new SearchResultEntry({ nodeId: firstNodeId, title: "First result", snippet: "First matching note" }),
  new SearchResultEntry({ nodeId: secondNodeId, title: "Second result", snippet: "Second matching note" })
]

const successfulSearch = (entries: ReadonlyArray<SearchResultEntry> = results) => ({
  status: "success" as const,
  value: new SearchNodesOutput({ results: entries })
})

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []

function LocationProbe() {
  const location = useLocation()
  return <output data-location>{location.pathname}</output>
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const press = (input: HTMLInputElement, key: string): void => {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
}

const mount = async (onNavigated = vi.fn()) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<MemoryRouter initialEntries={["/notes"]}><SearchBox onNavigated={onNavigated} /><LocationProbe /></MemoryRouter>)
    await flush()
  })
  const input = host.querySelector<HTMLInputElement>("input[type=search]")
  expect(input).not.toBeNull()
  return { host, input: input!, onNavigated }
}

const searchFor = async (input: HTMLInputElement, value = "project"): Promise<void> => {
  await act(async () => {
    setInput(input, value)
    await flush()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
    await flush()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  queryStateMock.current = successfulSearch()
})

afterEach(() => {
  vi.useRealTimers()
  queryStateMock.current = undefined
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
})

describe("SearchBox", () => {
  it("moves the active result with arrow keys and opens that result on Enter", async () => {
    const { host, input, onNavigated } = await mount()
    await searchFor(input)

    expect(input.getAttribute("role")).toBe("combobox")
    expect(input.getAttribute("aria-controls")).toBe("sidebar-search-results")
    expect(input.getAttribute("aria-activedescendant")).toBe("sidebar-search-option-0")
    expect(host.querySelectorAll("[role=option]")).toHaveLength(2)

    await act(async () => press(input, "ArrowDown"))
    expect(input.getAttribute("aria-activedescendant")).toBe("sidebar-search-option-1")
    expect(host.querySelector("#sidebar-search-option-1")?.getAttribute("aria-selected")).toBe("true")

    await act(async () => press(input, "Enter"))
    expect(host.querySelector("[data-location]")?.textContent).toBe(`/node/${secondNodeId}`)
    expect(onNavigated).toHaveBeenCalledTimes(1)
    expect(input.value).toBe("project")
    expect(input.getAttribute("aria-activedescendant")).toBe("sidebar-search-option-1")
    expect(host.querySelectorAll("[role=option]")).toHaveLength(2)
  })

  it("wraps selection and resets it when the query changes or Escape clears it", async () => {
    const { host, input } = await mount()
    await searchFor(input)

    await act(async () => press(input, "ArrowUp"))
    expect(input.getAttribute("aria-activedescendant")).toBe("sidebar-search-option-1")
    await act(async () => press(input, "ArrowDown"))
    expect(input.getAttribute("aria-activedescendant")).toBe("sidebar-search-option-0")

    await act(async () => setInput(input, "different"))
    expect(input.getAttribute("aria-expanded")).toBe("false")
    const status = host.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe("Searching…")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector(".shell-search-results")?.getAttribute("aria-live")).toBeNull()

    await act(async () => press(input, "Escape"))
    expect(input.value).toBe("")
    expect(input.getAttribute("aria-activedescendant")).toBeNull()
  })

  it("fails closed while loading, failed, or empty searches have no selectable result", async () => {
    const scenarios: ReadonlyArray<readonly [string, unknown]> = [
      ["loading", { status: "loading" }],
      ["failure", { status: "failure", error: new Error("offline") }],
      ["empty", successfulSearch([])]
    ]

    for (const [, queryState] of scenarios) {
      queryStateMock.current = queryState
      const { host, input } = await mount()
      await searchFor(input)

      await act(async () => {
        press(input, "ArrowDown")
        press(input, "Enter")
      })
      expect(host.querySelector("[data-location]")?.textContent).toBe("/notes")
      expect(input.getAttribute("aria-activedescendant")).toBeNull()
      const entry = roots.pop()
      if (entry !== undefined) {
        act(() => entry.root.unmount())
        entry.host.remove()
      }
    }
  })

  it("announces confirmed empty results as a polite atomic status", async () => {
    queryStateMock.current = successfulSearch([])
    const { host, input } = await mount()
    await searchFor(input, "unmatched phrase")

    const status = host.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe("No matches.")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)

    const entry = roots.pop()
    if (entry !== undefined) {
      act(() => entry.root.unmount())
      entry.host.remove()
    }
  })

  it("keeps direct result clicks working", async () => {
    const { host, input, onNavigated } = await mount()
    await searchFor(input)

    await act(async () => host.querySelector<HTMLButtonElement>("#sidebar-search-option-1")?.click())
    expect(host.querySelector("[data-location]")?.textContent).toBe(`/node/${secondNodeId}`)
    expect(onNavigated).toHaveBeenCalledTimes(1)
    expect(input.value).toBe("project")
    expect(host.querySelectorAll("[role=option]")).toHaveLength(2)
  })
})
