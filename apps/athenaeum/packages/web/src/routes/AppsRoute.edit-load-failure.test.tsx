/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError, type App } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byGeneration: new Map<number, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("../use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    const generation = dependencies[1]
    return typeof generation === "number"
      ? queryStateMock.byGeneration.get(generation) ?? queryStateMock.current
      : queryStateMock.current
  }
}))
vi.mock("../AppLauncherGrid.js", () => ({
  AppLauncherGrid: ({ onEdit }: { readonly onEdit: (appId: EntityId) => void }) => (
    <button type="button" onClick={() => onEdit(EntityId.make("00000000-0000-4000-8000-000000000001"))}>
      Edit test app
    </button>
  )
}))
vi.mock("../AppLaunchView.js", () => ({ AppLaunchView: () => <output data-app-launch-view /> }))
vi.mock("../AppLibraryPanel.js", () => ({
  AppDetail: ({ app }: { readonly app: App }) => <output data-app-detail data-app-id={app.id} data-app-title={app.title} />
}))

import { AppsRoute } from "./AppsRoute.js"

const appId = EntityId.make("00000000-0000-4000-8000-000000000001")
const app = {
  id: appId,
  title: "Counter",
  icon: "✦",
  serverCodeVersion: 2,
  clientCodeVersion: 7,
  revision: 4,
  acceptedRevision: 4,
  updatedAt: "2026-08-28T12:00:00.000Z"
} as App
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const buttonNamed = (host: HTMLDivElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

const retryGenerations = (): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<AppsRoute />)
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
  if (root === undefined) throw new Error("expected mounted AppsRoute root")
  await render(root)
}

const openEditor = async (host: HTMLDivElement): Promise<void> => {
  await act(async () => {
    buttonNamed(host, "Edit test app")?.click()
    await flush()
  })
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal app lookup detail" })
  }
  queryStateMock.byGeneration.clear()
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.current = undefined
  queryStateMock.byGeneration.clear()
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppsRoute editor load recovery", () => {
  it("keeps Back available, hides the editor, and retries only an unknown App lookup once at a time", async () => {
    const host = await mount()
    await openEditor(host)
    const alert = host.querySelector<HTMLElement>(".app-launch-load-state")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("This app couldn’t be loaded.")
    expect(alert?.textContent).toContain("Nothing was changed.")
    expect(host.textContent).not.toContain("Internal app lookup detail")
    expect(host.querySelector("[data-app-detail]")).toBeNull()
    expect(queryStateMock.dependencies).toEqual([[appId, 0]])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(retryGenerations()).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".app-launch-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.byGeneration.set(1, { status: "loading" as const })
    await rerender(host)
    expect(host.textContent).toContain("Loading…")
    const loadingStatus = host.querySelector('[role="status"]')
    expect(loadingStatus?.textContent).toBe("Loading…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.byGeneration.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Internal app lookup detail" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".app-launch-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(retryGenerations()).toEqual([0, 1, 2])

    await act(async () => {
      buttonNamed(host, "← Apps")?.click()
      await flush()
    })
    expect(buttonNamed(host, "Edit test app")).toBeDefined()
  })

  it("keeps a confirmed deleted App distinct from an unknown lookup failure", async () => {
    queryStateMock.current = { status: "failure" as const, error: { _tag: "AppNotFound" } }
    const host = await mount()
    await openEditor(host)

    expect(host.querySelector(".app-launch-load-state")).toBeNull()
    expect(host.querySelector(".app-launch-empty")?.textContent).toContain("This App was deleted.")
    expect(buttonNamed(host, "Retry")).toBeUndefined()
    expect(buttonNamed(host, "← Apps")).toBeDefined()
  })

  it("passes a successfully loaded App to the existing AppDetail contract", async () => {
    queryStateMock.current = { status: "success" as const, value: { app } }
    const host = await mount()
    await openEditor(host)
    const detail = host.querySelector<HTMLOutputElement>("[data-app-detail]")

    expect(detail?.dataset.appId).toBe(appId)
    expect(detail?.dataset.appTitle).toBe("Counter")
    expect(host.querySelector(".app-launch-load-state")).toBeNull()
  })
})
