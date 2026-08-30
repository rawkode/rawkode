/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EntityId, SearchNodesOutput, SearchResultEntry } from "@athenaeum/domain"

const queryStateMock = vi.hoisted(() => ({ current: undefined as unknown }))
const routerMock = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock("./use-effect-query.js", () => ({ useEffectQuery: () => queryStateMock.current }))
vi.mock("react-router", () => ({ useNavigate: () => routerMock.navigate }))

import { CommandPalette } from "./CommandPalette.js"
import { dailyNoteIdForDate } from "./daily-note-id.js"

const staleNodeId = EntityId.make("00000000-0000-4000-8000-000000000021")
const staleSearch = {
  status: "success" as const,
  value: new SearchNodesOutput({
    results: [new SearchResultEntry({ nodeId: staleNodeId, title: "Stale result", snippet: "A prior search result" })]
  })
}

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const press = (element: HTMLElement, key: string, options: KeyboardEventInit = {}): void => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }))
}

const mount = async () => {
  const onClose = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<CommandPalette open onClose={onClose} />)
    await flush()
  })
  const input = host.querySelector<HTMLInputElement>("input[type=search]")
  expect(input).not.toBeNull()
  return { host, input: input!, onClose }
}

const searchFor = async (input: HTMLInputElement, value: string): Promise<void> => {
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
  queryStateMock.current = staleSearch
  routerMock.navigate.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  queryStateMock.current = undefined
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
})

describe("CommandPalette search freshness", () => {
  it("advertises both supported palette modifiers", async () => {
    const { host } = await mount()
    const hints = Array.from(host.querySelectorAll(".command-palette-footer kbd")).map((hint) => hint.textContent)

    expect(hints).toContain("⌘K / Ctrl K")
  })

  it("labels recall and destination groups while keeping flat keyboard order", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: new SearchNodesOutput({
        results: [new SearchResultEntry({ nodeId: staleNodeId, title: "Today planning", snippet: "A matching note" })]
      })
    }
    const { host, input } = await mount()
    await searchFor(input, "today")

    const listbox = host.querySelector<HTMLElement>('[role="listbox"]')
    expect(listbox?.getAttribute("aria-label")).toBe("Recall and destinations")
    expect(Array.from(host.querySelectorAll<HTMLElement>('[role="group"]')).map((group) => group.getAttribute("aria-label")))
      .toEqual(["Recall", "Destinations"])
    expect(Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).map((option) => option.id))
      .toEqual(["command-palette-option-0", "command-palette-option-1"])
    expect(host.querySelector('[role="group"][aria-label="Recall"] .command-palette-option-kind')?.textContent).toBe("Record")
    expect(Array.from(host.querySelectorAll<HTMLElement>('[role="option"] .command-palette-option-label')).map((option) => option.textContent))
      .toEqual(["Today planning", "Today"])
  })

  it("removes a prior query's result during debounce so Arrow/Enter cannot navigate it", async () => {
    const { host, input, onClose } = await mount()
    await searchFor(input, "archival phrase")
    expect(host.textContent).toContain("Stale result")

    await act(async () => {
      setInput(input, "different phrase")
      await flush()
    })
    expect(host.textContent).not.toContain("Stale result")
    const status = host.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe("Searching…")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
    expect(input.getAttribute("aria-expanded")).toBe("false")
    expect(input.getAttribute("aria-activedescendant")).toBeNull()

    await act(async () => {
      press(input, "ArrowDown")
      press(input, "Enter")
    })
    expect(routerMock.navigate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("announces a confirmed empty search without changing its visible guidance", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: new SearchNodesOutput({ results: [] })
    }
    const { host, input } = await mount()

    expect(input.getAttribute("aria-autocomplete")).toBe("list")
    expect(input.getAttribute("aria-expanded")).toBe("true")
    expect(input.getAttribute("aria-controls")).toBe("command-palette-options")
    expect(input.getAttribute("aria-activedescendant")).toBe("command-palette-option-0")
    expect(host.querySelector('[role="listbox"]')).not.toBeNull()

    await searchFor(input, "unmatched phrase")

    const status = host.querySelector<HTMLElement>('[role="status"]')
    expect(status?.textContent).toBe("No matching notes or destinations.")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(input.getAttribute("aria-expanded")).toBe("false")
    expect(input.getAttribute("aria-activedescendant")).toBeNull()
  })

  it("contains keyboard focus and closes from a focused destination", async () => {
    const { host, input, onClose } = await mount()
    const options = Array.from(host.querySelectorAll<HTMLButtonElement>(".command-palette-option"))
    const disabledLast = options.at(-1)
    disabledLast!.disabled = true
    const lastEnabled = options.at(-2)
    expect(lastEnabled).toBeDefined()

    input.focus()
    await act(async () => { press(input, "Tab", { shiftKey: true }) })
    expect(document.activeElement).toBe(lastEnabled)

    await act(async () => { press(lastEnabled!, "Tab") })
    expect(document.activeElement).toBe(input)

    await act(async () => { press(lastEnabled!, "Escape") })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("opens a canonical daily-note result in the date-addressed editor", async () => {
    const dailyNoteId = dailyNoteIdForDate(new Date(2026, 7, 22))
    queryStateMock.current = {
      status: "success" as const,
      value: new SearchNodesOutput({
        results: [new SearchResultEntry({ nodeId: dailyNoteId, title: "Daily Note — 2026-08-22", snippet: "A daily note" })]
      })
    }
    const { input, onClose } = await mount()
    await searchFor(input, "2026-08-22")

    await act(async () => press(input, "Enter"))
    expect(routerMock.navigate).toHaveBeenCalledWith("/notes?date=2026-08-22")
    expect(onClose).toHaveBeenCalledOnce()
  })
})
