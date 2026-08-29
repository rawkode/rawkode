/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({ dependencies: [] as ReadonlyArray<unknown>[] }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return {
      status: "success" as const,
      value: {
        rows: [
          { id: "00000000-0000-4000-8000-000000000001", title: "Project north", createdAt: "2026-08-28T10:00:00.000Z" },
          { id: "00000000-0000-4000-8000-000000000002", title: "Project south", createdAt: "2026-08-28T09:00:00.000Z" }
        ]
      }
    }
  }
}))
vi.mock("react-router", () => ({
  Link: ({ to, children, className }: { readonly to: string; readonly children: ReactNode; readonly className?: string }) => (
    <a className={className} href={to}>{children}</a>
  )
}))

import { GraphView } from "./GraphView.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<GraphView />)
    await flush()
  })
  return host
}

const personAssignmentButton = (host: HTMLElement): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".graph-view-col-action button")]
    .find((button) => button.textContent === "+ Person")

const personAssignmentButtons = (host: HTMLElement): ReadonlyArray<HTMLButtonElement> =>
  [...host.querySelectorAll<HTMLButtonElement>(".graph-view-col-action button")]

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.dependencies = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("GraphView Person assignment failure privacy", () => {
  it("does not mint a second assignment for a rapid action while the first is pending", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const host = await mount()
    const [first, second] = personAssignmentButtons(host)

    await act(async () => {
      first?.click()
      second?.click()
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(first?.textContent).toBe("Tagging…")
    expect(first?.disabled).toBe(true)
    expect(second?.textContent).toBe("+ Person")
    expect(second?.disabled).toBe(true)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: "private first-assignment detail" })))
      await flush()
    })

    expect(personAssignmentButtons(host).every((button) => !button.disabled)).toBe(true)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("private first-assignment detail"))
  })

  it("keeps an unfiltered uncertain assignment generic and refreshes only after confirmed success", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private graph assignment detail"
    const host = await mount()
    const dependenciesBeforeAssignment = queryStateMock.dependencies.length

    await act(async () => {
      personAssignmentButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this entity was tagged Person.")
    expect(alert?.textContent).toContain("Review the graph before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(personAssignmentButton(host)?.textContent).toBe("+ Person")
    expect(host.querySelector(".graph-view-title-link")?.textContent).toBe("Project north")
    expect(queryStateMock.dependencies.slice(dependenciesBeforeAssignment)).toEqual(
      expect.arrayContaining([[false, 0]])
    )
    expect(queryStateMock.dependencies.slice(dependenciesBeforeAssignment).every(
      (dependencies) => dependencies[0] === false && dependencies[1] === 0
    )).toBe(true)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(privateDetail))

    await act(async () => {
      personAssignmentButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

    await act(async () => {
      observers[1]?.(Exit.succeed(undefined))
      await flush()
    })

    expect(host.querySelector("[role='alert']")).toBeNull()
    expect(queryStateMock.dependencies.at(-1)).toEqual([false, 1])
  })
})
