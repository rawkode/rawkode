/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  byAppAndGeneration: new Map<string, unknown>(),
  current: undefined as unknown,
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.byAppAndGeneration.get(`${dependencies[0]}:${dependencies[1]}`) ?? queryStateMock.current
  }
}))
vi.mock("./AppRunFrame.js", () => ({
  AppRunFrame: ({ appId, clientCodeVersion, className }: { readonly appId: string; readonly clientCodeVersion: number; readonly className: string }) => (
    <output data-app-run-frame data-app-id={appId} data-client-code-version={String(clientCodeVersion)} className={className} />
  )
}))

import { AppLaunchView } from "./AppLaunchView.js"

const appId = EntityId.make("00000000-0000-4000-8000-000000000001")
const otherAppId = EntityId.make("00000000-0000-4000-8000-000000000002")
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const buttonNamed = (host: HTMLDivElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

const retryGenerations = (id: EntityId): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .filter((dependencies) => dependencies[0] === id)
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

const render = async (
  root: Root,
  renderedAppId: EntityId,
  onBack: () => void,
  onEdit: () => void
): Promise<void> => {
  await act(async () => {
    root.render(<AppLaunchView appId={renderedAppId} onBack={onBack} onEdit={onEdit} />)
    await flush()
  })
}

const mount = async (renderedAppId = appId) => {
  const onBack = vi.fn()
  const onEdit = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root, renderedAppId, onBack, onEdit)
  return { host, onBack, onEdit }
}

const rerender = async (host: HTMLDivElement, renderedAppId = appId): Promise<void> => {
  const root = roots.find((entry) => entry.host === host)?.root
  if (root === undefined) throw new Error("expected mounted AppLaunchView root")
  await render(root, renderedAppId, vi.fn(), vi.fn())
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.byAppAndGeneration.clear()
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal app lookup detail" })
  }
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.byAppAndGeneration.clear()
  queryStateMock.current = undefined
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppLaunchView load recovery", () => {
  it("keeps Back available, hides edit, and retries an unknown app lookup once at a time", async () => {
    const { host, onBack } = await mount()
    const alert = host.querySelector<HTMLElement>(".app-launch-load-state")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("This app couldn’t be loaded.")
    expect(alert?.textContent).toContain("Nothing was changed.")
    expect(host.textContent).not.toContain("Internal app lookup detail")
    expect(buttonNamed(host, "Edit code")).toBeUndefined()
    expect(retryGenerations(appId)).toEqual([0])

    await act(async () => {
      buttonNamed(host, "← Apps")?.click()
      await flush()
    })
    expect(onBack).toHaveBeenCalledTimes(1)

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(retryGenerations(appId)).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".app-launch-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.byAppAndGeneration.set(`${appId}:1`, { status: "loading" as const })
    await rerender(host)
    expect(host.textContent).toContain("Loading…")
    const loadingStatus = host.querySelector('[role="status"]')
    expect(loadingStatus?.textContent).toBe("Loading…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.byAppAndGeneration.set(`${appId}:1`, {
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
    expect(retryGenerations(appId)).toEqual([0, 1, 2])
  })

  it("clears a claimed retry when the launch view receives a different App", async () => {
    const { host } = await mount()
    const alert = host.querySelector<HTMLElement>(".app-launch-load-state")

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(retryGenerations(appId)).toEqual([0, 1])
    expect(host.querySelector<HTMLButtonElement>(".app-launch-load-state button")?.disabled).toBe(true)

    await rerender(host, otherAppId)
    expect(retryGenerations(otherAppId)).toEqual([1])
    const releasedButton = host.querySelector<HTMLButtonElement>(".app-launch-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(retryGenerations(otherAppId)).toEqual([1, 2])
  })

  it("keeps a confirmed missing App distinct from an unknown failure", async () => {
    queryStateMock.current = { status: "failure" as const, error: { _tag: "AppNotFound" } }
    const { host } = await mount()

    expect(host.querySelector(".app-launch-load-state")).toBeNull()
    expect(host.querySelector(".app-launch-empty")?.textContent).toContain("This App no longer exists.")
    expect(buttonNamed(host, "Retry")).toBeUndefined()
    expect(buttonNamed(host, "Edit code")).toBeUndefined()
    expect(buttonNamed(host, "← Apps")).toBeDefined()
  })

  it("keeps the successful title, edit action, and AppRunFrame contract", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: {
        app: { icon: "✦", title: "Counter", clientCodeVersion: 7 }
      }
    }
    const { host, onEdit } = await mount()
    const frame = host.querySelector<HTMLOutputElement>("[data-app-run-frame]")

    expect(host.querySelector(".app-launch-title")?.textContent).toBe("Counter")
    expect(frame?.dataset.appId).toBe(appId)
    expect(frame?.dataset.clientCodeVersion).toBe("7")
    expect(frame?.className).toBe("app-launch-frame")

    await act(async () => {
      buttonNamed(host, "Edit code")?.click()
      await flush()
    })
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})
