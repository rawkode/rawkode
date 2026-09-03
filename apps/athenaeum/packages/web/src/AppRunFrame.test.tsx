/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.current
  }
}))

import { AppRunFrame } from "./AppRunFrame.js"

const appId = EntityId.make("00000000-0000-4000-8000-000000000001")
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (clientCodeVersion = 4, initialAppId = appId): Promise<{
  readonly host: HTMLDivElement
  readonly rerender: (nextAppId?: EntityId) => Promise<void>
}> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  let renderedAppId = initialAppId
  const rerender = async (nextAppId = renderedAppId): Promise<void> => {
    renderedAppId = nextAppId
    await act(async () => {
      root.render(<AppRunFrame appId={renderedAppId} clientCodeVersion={clientCodeVersion} className="test-app-frame" />)
      await flush()
    })
  }
  await rerender()
  return { host, rerender }
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal credential issuer detail" })
  }
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.current = undefined
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppRunFrame credential recovery", () => {
  it("keeps a credential failure generic and retries only that credential query", async () => {
    const { host } = await mount()
    const alert = host.querySelector<HTMLElement>(".app-run-frame-failure")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("This app couldn’t start.")
    expect(alert?.textContent).toContain("Its code and workspace are unchanged.")
    expect(host.textContent).not.toContain("Internal credential issuer detail")
    expect(host.querySelector("iframe")).toBeNull()
    expect(queryStateMock.dependencies).toEqual([[appId, 0]])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(queryStateMock.dependencies).toEqual([[appId, 0], [appId, 1]])
  })

  it("keeps the no-code state distinct and preserves the exact sandbox frame after a successful mint", async () => {
    const { host: noCodeHost } = await mount(0)
    expect(noCodeHost.textContent).toContain("No client code yet")
    expect(noCodeHost.querySelector("[role=alert]")).toBeNull()

    queryStateMock.current = {
      status: "success" as const,
      value: { credential: "scoped-run-credential" }
    }
    const { host: successHost } = await mount()
    const frame = successHost.querySelector<HTMLIFrameElement>("iframe.test-app-frame")

    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame?.getAttribute("title")).toBe("App")
    expect(frame?.getAttribute("srcdoc")).toContain("scoped-run-credential")
  })

  it("claims credential retry synchronously and releases it only after loading settles", async () => {
    const { host, rerender } = await mount()
    const retry = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(".app-run-frame-failure button")

    await act(async () => {
      retry()?.click()
      retry()?.click()
      await flush()
    })

    expect(queryStateMock.dependencies).toEqual([[appId, 0], [appId, 1]])
    expect(retry()?.disabled).toBe(true)
    expect(retry()?.textContent).toBe("Retrying…")

    queryStateMock.current = { status: "loading" as const }
    await rerender()
    const status = host.querySelector<HTMLElement>("[role=status]")
    expect(status?.textContent).toBe("Preparing sandbox…")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector("iframe")).toBeNull()

    queryStateMock.current = {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Second credential issuer detail" })
    }
    await rerender()

    expect(retry()?.disabled).toBe(false)
    expect(retry()?.textContent).toBe("Retry")

    await act(async () => {
      retry()?.click()
      await flush()
    })

    expect(queryStateMock.dependencies.some((dependencies) => dependencies[0] === appId && dependencies[1] === 2)).toBe(true)
  })

  it("releases a stale credential retry claim when the frame switches apps", async () => {
    const { host, rerender } = await mount()
    const otherAppId = EntityId.make("00000000-0000-4000-8000-000000000002")

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".app-run-frame-failure button")?.click()
      await flush()
    })
    expect(host.querySelector<HTMLButtonElement>(".app-run-frame-failure button")?.disabled).toBe(true)

    await rerender(otherAppId)

    expect(host.querySelector<HTMLButtonElement>(".app-run-frame-failure button")?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>(".app-run-frame-failure button")?.textContent).toBe("Retry")
  })
})
