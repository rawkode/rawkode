/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { App, AppIcon, EntityId, IsoDateTimeString, UnexpectedError, WorkspaceNotFound } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  byGeneration: new Map<number, unknown>(),
  deps: [] as ReadonlyArray<unknown>[]
}))

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))

vi.mock("./runtime.js", () => ({ runtime: { runFork: runtimeMock.runFork } }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.deps.push([...dependencies])
    const generation = dependencies[0]
    return typeof generation === "number"
      ? queryStateMock.byGeneration.get(generation) ?? {
          status: "failure" as const,
          error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000001" })
        }
      : undefined
  }
}))

import { AppLauncherGrid } from "./AppLauncherGrid.js"

const existingApp = new App({
  id: EntityId.make("00000000-0000-4000-8000-000000000002"),
  workspaceId: EntityId.make("00000000-0000-4000-8000-000000000001"),
  title: "Counter",
  icon: AppIcon.make("🔢"),
  clientCodeVersion: 1,
  serverCodeVersion: 1,
  revision: 1,
  acceptedRevision: 1,
  createdAt: IsoDateTimeString.make("2026-08-28T12:00:00.000Z"),
  updatedAt: IsoDateTimeString.make("2026-08-28T12:00:00.000Z")
})

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const retryGenerations = (): number[] => [
  ...new Set(
    queryStateMock.deps
      .map((dependencies) => dependencies[0])
      .filter((value): value is number => typeof value === "number")
  )
]

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<AppLauncherGrid onLaunch={vi.fn()} onEdit={vi.fn()} />)
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
  if (root === undefined) throw new Error("expected mounted AppLauncherGrid root")
  await render(root)
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.byGeneration.clear()
  queryStateMock.deps = []
  runtimeMock.runFork.mockReset()
})

afterEach(() => {
  queryStateMock.byGeneration.clear()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppLauncherGrid load failures", () => {
  it("keeps app creation available and retries the app-list query once at a time", async () => {
    const host = await mount()

    expect(host.querySelectorAll(".app-launcher-load-state")).toHaveLength(1)
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Apps could not be loaded.")
    expect(host.textContent).not.toContain("This workspace doesn't exist")
    expect(host.textContent).not.toContain("Make a tool for the moment")
    expect(host.querySelector<HTMLButtonElement>(".app-tile-new")?.textContent).toContain("New App")
    expect(retryGenerations()).toEqual([0])

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".app-launcher-load-state button")?.click()
      host.querySelector<HTMLButtonElement>(".app-launcher-load-state button")?.click()
      await flush()
    })

    expect(retryGenerations()).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".app-launcher-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.byGeneration.set(1, { status: "loading" as const })
    await rerender(host)
    expect(host.textContent).toContain("Loading…")
    expect(host.querySelector<HTMLButtonElement>(".app-tile-new")?.textContent).toContain("New App")

    queryStateMock.byGeneration.set(1, {
      status: "failure" as const,
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000001" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".app-launcher-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(retryGenerations()).toEqual([0, 1, 2])
  })

  it("retains previously loaded apps through a refresh and failure until a current empty result arrives", async () => {
    const privateDetail = "private app catalog provider detail"
    queryStateMock.byGeneration.set(0, { status: "success" as const, value: { apps: [existingApp] } })
    const host = await mount()

    expect(host.querySelector(".app-tile-title")?.textContent).toBe("Counter")
    expect(host.textContent).not.toContain("Make a tool for the moment")
    expect(host.querySelector<HTMLButtonElement>(".app-tile-new")?.textContent).toContain("New App")

    queryStateMock.byGeneration.set(0, {
      status: "failure" as const,
      error: new UnexpectedError({ message: privateDetail })
    })
    await rerender(host)

    const retryButton = host.querySelector<HTMLButtonElement>(".app-launcher-load-state button")
    expect(host.querySelector(".app-tile-title")?.textContent).toBe("Counter")
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Apps could not be refreshed.")
    expect(host.textContent).not.toContain(privateDetail)

    queryStateMock.byGeneration.set(1, { status: "loading" as const })
    await act(async () => {
      retryButton?.click()
      await flush()
    })

    expect(retryGenerations()).toEqual([0, 1])
    expect(host.textContent).toContain("Refreshing apps…")
    expect(host.querySelector(".app-tile-title")?.textContent).toBe("Counter")
    expect(host.textContent).not.toContain("Make a tool for the moment")

    queryStateMock.byGeneration.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: privateDetail })
    })
    await rerender(host)

    expect(host.querySelector(".app-tile-title")?.textContent).toBe("Counter")
    expect(host.querySelector("[role=alert]")?.textContent).toContain("previously loaded apps remain available")
    expect(host.textContent).not.toContain(privateDetail)

    queryStateMock.byGeneration.set(1, { status: "success" as const, value: { apps: [] } })
    await rerender(host)

    expect(host.querySelector(".app-tile[aria-label='Launch Counter']")).toBeNull()
    expect(host.textContent).toContain("Make a tool for the moment")
    expect(host.querySelector<HTMLButtonElement>(".app-tile-new")?.textContent).toContain("New App")
  })

  it("opens the existing app form from the empty-state CTA without creating an app", async () => {
    queryStateMock.byGeneration.set(0, { status: "success" as const, value: { apps: [] } })
    const host = await mount()

    const createFromEmptyState = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create an app")
    expect(createFromEmptyState).toBeDefined()
    expect(host.querySelector(".app-create-form")).toBeNull()

    await act(async () => {
      createFromEmptyState?.click()
      await flush()
    })

    expect(host.querySelector(".app-create-form")).not.toBeNull()
    expect(host.querySelector<HTMLInputElement>("[aria-label='App icon']")).not.toBeNull()
    expect(host.querySelector<HTMLInputElement>("[aria-label='App title']")).not.toBeNull()
    expect(host.querySelector(".app-tile-new")).toBeNull()
    expect(runtimeMock.runFork).not.toHaveBeenCalled()

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".app-create-form-cancel")?.click()
      await flush()
    })

    const createFromGrid = host.querySelector<HTMLButtonElement>(".app-tile-new")
    expect(createFromGrid?.textContent).toContain("New App")
    await act(async () => {
      createFromGrid?.click()
      await flush()
    })

    expect(host.querySelector(".app-create-form")).not.toBeNull()
    expect(runtimeMock.runFork).not.toHaveBeenCalled()
  })
})
