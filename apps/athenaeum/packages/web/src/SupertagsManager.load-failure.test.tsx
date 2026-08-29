/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byGeneration: new Map<number, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./AddTagFieldForm.js", () => ({ AddTagFieldForm: () => null }))
vi.mock("./runtime.js", () => ({ runtime: { runFork: vi.fn() } }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    const generation = dependencies[0]
    return typeof generation === "number"
      ? queryStateMock.byGeneration.get(generation) ?? queryStateMock.current
      : queryStateMock.current
  }
}))

import { SupertagsManager } from "./SupertagsManager.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const catalogGenerations = (): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .map((dependencies) => dependencies[0])
      .filter((value): value is number => typeof value === "number")
  )
]

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<SupertagsManager />)
    await flush()
  })
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return host
}

const rerender = async (host: HTMLDivElement): Promise<void> => {
  const root = roots.find((entry) => entry.host === host)?.root
  if (root === undefined) throw new Error("expected mounted SupertagsManager root")
  await render(root)
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.byGeneration.clear()
  queryStateMock.dependencies = []
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal tag catalog detail" })
  }
})

afterEach(() => {
  queryStateMock.current = undefined
  queryStateMock.byGeneration.clear()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SupertagsManager catalog recovery", () => {
  it("keeps root-tag creation available and retries a catalog read once at a time", async () => {
    const host = await mount()

    const alert = host.querySelector<HTMLElement>(".supertags-catalog-load-state")
    expect(host.querySelectorAll(".supertags-catalog-load-state")).toHaveLength(1)
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Supertags couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal tag catalog detail")
    expect(host.textContent).not.toContain("No Supertags yet.")
    expect(host.querySelector(".supertags-create-disclosure summary")?.textContent).toContain("New Supertag")
    expect(host.querySelector<HTMLInputElement>("[aria-label='New Supertag name']")).not.toBeNull()
    expect(host.querySelector(".supertags-create-form-parents")).toBeNull()
    expect(catalogGenerations()).toEqual([0])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(catalogGenerations()).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".supertags-catalog-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.byGeneration.set(1, { status: "loading" as const })
    await rerender(host)
    const loadingStatus = host.querySelector<HTMLElement>("[role=status]")
    expect(loadingStatus?.textContent).toContain("Loading tags…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector<HTMLInputElement>("[aria-label='New Supertag name']")).not.toBeNull()

    queryStateMock.byGeneration.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Internal tag catalog detail" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".supertags-catalog-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(catalogGenerations()).toEqual([0, 1, 2])
  })

  it("keeps a successful empty tag catalog distinct from a failed request", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: []
    }

    const host = await mount()

    expect(host.querySelector(".supertags-catalog-load-state")).toBeNull()
    expect(host.querySelector(".supertags-empty")?.textContent).toContain("No Supertags yet.")
    expect(host.querySelector("[role='alert']")).toBeNull()
  })
})
