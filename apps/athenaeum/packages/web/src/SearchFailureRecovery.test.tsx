/** @vitest-environment happy-dom */

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  outcomes: new Map<string, "loading" | "failure">(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))
const routerMock = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    const query = dependencies[1]
    const retryKey = dependencies[2]
    const outcome = typeof query === "string" && typeof retryKey === "number"
      ? queryStateMock.outcomes.get(`${query}:${retryKey}`)
      : undefined
    if (outcome === "loading") return { status: "loading" as const }
    if (outcome === "failure") return queryStateMock.current
    return queryStateMock.current
  }
}))
vi.mock("react-router", () => ({ useNavigate: () => routerMock.navigate }))

import { CommandPalette } from "./CommandPalette.js"
import { SearchBox } from "./SearchBox.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
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

const press = (input: HTMLInputElement, key: string): void => {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

const render = async (root: Root, element: ReactElement): Promise<void> => {
  await act(async () => {
    root.render(element)
    await flush()
  })
}

const mount = async (element: ReactElement): Promise<{ readonly root: Root; readonly host: HTMLDivElement; readonly input: HTMLInputElement }> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root, element)
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')
  expect(input).not.toBeNull()
  return { root, host, input: input! }
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  queryStateMock.current = { status: "failure", error: new Error("Internal search backend detail") }
  queryStateMock.outcomes.clear()
  queryStateMock.dependencies = []
  routerMock.navigate.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  queryStateMock.current = undefined
  queryStateMock.outcomes.clear()
  queryStateMock.dependencies = []
  routerMock.navigate.mockReset()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("node search failure recovery", () => {
  it("keeps a failed sidebar query, suppresses stale navigation, and retries the same query generation", async () => {
    const { root, host, input } = await mount(<SearchBox />)
    await searchFor(input, "project")

    const alert = host.querySelector<HTMLElement>(".shell-search-failure")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Search couldn’t be completed.")
    expect(host.textContent).not.toContain("Internal search backend detail")
    expect(host.querySelectorAll("[role=option]")).toHaveLength(0)
    expect(queryStateMock.dependencies).toContainEqual([true, "project", 0])

    await act(async () => {
      press(input, "ArrowDown")
      press(input, "Enter")
      await flush()
    })
    expect(routerMock.navigate).not.toHaveBeenCalled()

    const dependencyCountBeforeRetry = queryStateMock.dependencies.length
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(input.value).toBe("project")
    expect(queryStateMock.dependencies.slice(dependencyCountBeforeRetry)).toEqual([[true, "project", 1]])
    expect(host.querySelector<HTMLButtonElement>(".shell-search-failure button")?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>(".shell-search-failure button")?.textContent).toBe("Retrying…")

    queryStateMock.outcomes.set("project:1", "loading")
    await render(root, <SearchBox />)
    expect(host.querySelector(".shell-search-failure")).toBeNull()
    expect(host.querySelector(".shell-search-status")?.textContent).toBe("Searching…")
    expect(input.value).toBe("project")

    queryStateMock.outcomes.set("project:1", "failure")
    await render(root, <SearchBox />)
    const releasedRetry = host.querySelector<HTMLButtonElement>(".shell-search-failure button")
    expect(releasedRetry?.disabled).toBe(false)
    expect(releasedRetry?.textContent).toBe("Retry")
    const dependencyCountBeforeNextRetry = queryStateMock.dependencies.length

    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(queryStateMock.dependencies.slice(dependencyCountBeforeNextRetry)).toEqual([[true, "project", 2]])
  })

  it("keeps palette commands usable while a failed note search retries without losing the query", async () => {
    const onClose = vi.fn()
    const { root, host, input } = await mount(<CommandPalette open onClose={onClose} />)
    await searchFor(input, "today")

    const alert = host.querySelector<HTMLElement>(".command-palette-search-failure")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Search couldn’t be completed.")
    expect(host.textContent).not.toContain("Internal search backend detail")
    expect(host.querySelector("[role=option]")?.textContent).toContain("Today")
    expect(queryStateMock.dependencies).toContainEqual([true, "today", 0])

    const dependencyCountBeforeRetry = queryStateMock.dependencies.length
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(input.value).toBe("today")
    expect(queryStateMock.dependencies.slice(dependencyCountBeforeRetry)).toEqual([[true, "today", 1]])
    expect(host.querySelector<HTMLButtonElement>(".command-palette-search-failure button")?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>(".command-palette-search-failure button")?.textContent).toBe("Retrying…")

    await act(async () => {
      press(input, "Enter")
      await flush()
    })
    expect(routerMock.navigate).toHaveBeenLastCalledWith("/notes")
    expect(onClose).toHaveBeenCalledTimes(1)

    queryStateMock.outcomes.set("today:1", "loading")
    await render(root, <CommandPalette open onClose={onClose} />)
    expect(host.querySelector(".command-palette-search-failure")).toBeNull()
    expect(host.querySelector("[role=option]")?.textContent).toContain("Today")

    queryStateMock.outcomes.set("today:1", "failure")
    await render(root, <CommandPalette open onClose={onClose} />)
    const releasedRetry = host.querySelector<HTMLButtonElement>(".command-palette-search-failure button")
    expect(releasedRetry?.disabled).toBe(false)
    expect(releasedRetry?.textContent).toBe("Retry")
    const dependencyCountBeforeNextRetry = queryStateMock.dependencies.length

    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(queryStateMock.dependencies.slice(dependencyCountBeforeNextRetry)).toEqual([[true, "today", 2]])
  })
})
