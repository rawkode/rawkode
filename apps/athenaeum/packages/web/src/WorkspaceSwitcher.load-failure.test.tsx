/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const userRpcMock = vi.hoisted(() => ({
  openUserSession: vi.fn(),
  closeUserSession: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn()
}))

vi.mock("./user-rpc-client.js", () => userRpcMock)

import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js"

const activeWorkspaceId = "00000000-0000-4000-8000-000000000001" as never
const session = {
  email: "writer@example.com",
  credential: "test-credential",
  issuedAt: "2026-08-28T00:00:00.000Z",
  expiresAt: "2026-08-29T00:00:00.000Z"
}
const catalogEntry = {
  workspaceId: activeWorkspaceId,
  title: "Personal",
  ownerId: "writer@example.com",
  role: "build",
  isDefault: true
}
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const deferred = <A,>() => {
  let resolve!: (value: A | PromiseLike<A>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const mount = async (variant: "default" | "sidebar-compact" = "default"): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<WorkspaceSwitcher session={session} activeWorkspaceId={activeWorkspaceId} onSwitch={vi.fn()} variant={variant} />)
    await flush()
  })
  return host
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  userRpcMock.openUserSession.mockReset()
  userRpcMock.closeUserSession.mockReset()
  userRpcMock.listWorkspaces.mockReset()
  userRpcMock.createWorkspace.mockReset()
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("WorkspaceSwitcher catalog recovery", () => {
  it("keeps the compact location control closed at rest and reveals the existing management flow on demand", async () => {
    const catalogStub = { label: "catalog" }
    userRpcMock.openUserSession.mockReturnValue(catalogStub)
    userRpcMock.listWorkspaces.mockResolvedValue([catalogEntry])

    const host = await mount("sidebar-compact")
    const disclosure = host.querySelector<HTMLDetailsElement>(".workspace-switcher--compact")
    const summary = disclosure?.querySelector<HTMLElement>("summary")

    expect(disclosure?.open).toBe(false)
    expect(summary?.getAttribute("aria-label")).toBe("Current workspace: Personal")
    expect(summary?.textContent).toContain("Workspace")
    expect(summary?.textContent).toContain("Personal")
    expect(host.textContent).not.toContain(activeWorkspaceId)

    await act(async () => {
      summary?.click()
      await flush()
    })

    expect(disclosure?.open).toBe(true)
    expect(host.querySelector("#workspace-switcher-select")).not.toBeNull()
    expect(host.querySelector(".workspace-switcher-manage")).not.toBeNull()
  })

  it("suppresses raw catalog failures, preserves management, and retries one catalog read at a time", async () => {
    const firstStub = { label: "first" }
    const secondStub = { label: "second" }
    const thirdStub = { label: "third" }
    const failedRetry = deferred<ReadonlyArray<typeof catalogEntry>>()
    userRpcMock.openUserSession
      .mockReturnValueOnce(firstStub)
      .mockReturnValueOnce(secondStub)
      .mockReturnValueOnce(thirdStub)
    userRpcMock.listWorkspaces
      .mockRejectedValueOnce(new Error("Internal user catalog detail"))
      .mockReturnValueOnce(failedRetry.promise)
      .mockResolvedValueOnce([catalogEntry])

    const host = await mount()

    const alert = host.querySelector<HTMLElement>(".workspace-switcher-load-state")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Workspaces couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal user catalog detail")
    expect(host.querySelector("#workspace-switcher-select")).toBeNull()
    expect(host.querySelector(".workspace-switcher-manage")).not.toBeNull()
    expect(host.querySelector<HTMLInputElement>("#workspace-switcher-new-title")).not.toBeNull()
    expect(userRpcMock.openUserSession).toHaveBeenCalledWith(session.credential)
    expect(userRpcMock.listWorkspaces).toHaveBeenCalledWith(firstStub)

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(host.querySelector(".workspace-switcher-load-state")).toBeNull()
    expect(host.querySelector(".workspace-switcher-loading")?.textContent).toContain("loading…")
    expect(host.querySelector("#workspace-switcher-select")).toBeNull()
    expect(host.querySelector(".workspace-switcher-manage")).not.toBeNull()
    expect(userRpcMock.openUserSession).toHaveBeenCalledTimes(2)
    expect(userRpcMock.listWorkspaces).toHaveBeenCalledTimes(2)
    expect(userRpcMock.listWorkspaces).toHaveBeenNthCalledWith(1, firstStub)
    expect(userRpcMock.listWorkspaces).toHaveBeenNthCalledWith(2, secondStub)
    expect(userRpcMock.closeUserSession).toHaveBeenCalledWith(firstStub)

    await act(async () => {
      failedRetry.reject(new Error("Retried catalog provider detail"))
      await flush()
    })

    const retryAlert = host.querySelector<HTMLElement>(".workspace-switcher-load-state")
    const releasedButton = retryAlert?.querySelector<HTMLButtonElement>("button")
    expect(retryAlert?.textContent).toContain("Workspaces couldn’t be loaded.")
    expect(host.textContent).not.toContain("Retried catalog provider detail")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })

    const select = host.querySelector<HTMLSelectElement>("#workspace-switcher-select")
    expect(host.querySelector(".workspace-switcher-load-state")).toBeNull()
    expect(select?.value).toBe(activeWorkspaceId)
    expect(select?.options[0]?.textContent).toBe("Personal")
    expect(userRpcMock.openUserSession).toHaveBeenNthCalledWith(1, session.credential)
    expect(userRpcMock.openUserSession).toHaveBeenNthCalledWith(2, session.credential)
    expect(userRpcMock.openUserSession).toHaveBeenNthCalledWith(3, session.credential)
    expect(userRpcMock.listWorkspaces).toHaveBeenNthCalledWith(1, firstStub)
    expect(userRpcMock.listWorkspaces).toHaveBeenNthCalledWith(2, secondStub)
    expect(userRpcMock.listWorkspaces).toHaveBeenNthCalledWith(3, thirdStub)
    expect(userRpcMock.closeUserSession).toHaveBeenCalledWith(firstStub)
    expect(userRpcMock.closeUserSession).toHaveBeenCalledWith(secondStub)
  })

  it("removes a previously loaded selection when a later catalog request fails", async () => {
    const firstStub = { label: "first" }
    const secondStub = { label: "second" }
    userRpcMock.openUserSession.mockReturnValueOnce(firstStub).mockReturnValueOnce(secondStub)
    userRpcMock.listWorkspaces
      .mockResolvedValueOnce([catalogEntry])
      .mockRejectedValueOnce(new Error("Refreshed catalog detail"))

    const host = await mount()
    expect(host.querySelector("#workspace-switcher-select")).not.toBeNull()

    const refreshedSession = { ...session, credential: "refreshed-test-credential" }
    const root = roots.at(-1)?.root
    await act(async () => {
      root?.render(<WorkspaceSwitcher session={refreshedSession} activeWorkspaceId={activeWorkspaceId} onSwitch={vi.fn()} />)
      await flush()
    })

    expect(host.querySelector("#workspace-switcher-select")).toBeNull()
    expect(host.querySelector(".workspace-switcher-load-state")?.textContent).toContain("Workspaces couldn’t be loaded.")
    expect(host.querySelector(".workspace-switcher-manage")).not.toBeNull()
    expect(userRpcMock.listWorkspaces).toHaveBeenNthCalledWith(1, firstStub)
    expect(userRpcMock.listWorkspaces).toHaveBeenNthCalledWith(2, secondStub)
  })
})
