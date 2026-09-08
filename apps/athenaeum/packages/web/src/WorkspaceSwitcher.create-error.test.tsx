/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const userRpcMock = vi.hoisted(() => ({
  openUserSession: vi.fn(),
  closeUserSession: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn()
}))

vi.mock("./user-rpc-client.js", () => userRpcMock)

import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js"

const activeWorkspaceId = EntityId.make("00000000-0000-4000-8000-000000000001")
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
const createdWorkspace = {
  workspaceId: EntityId.make("00000000-0000-4000-8000-000000000002"),
  title: "Research",
  ownerId: "writer@example.com",
  role: "build",
  isDefault: false
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

const mount = async (onSwitch: (workspaceId: EntityId, title: string) => void): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<WorkspaceSwitcher session={session} activeWorkspaceId={activeWorkspaceId} onSwitch={onSwitch} />)
    await flush()
  })
  return host
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  userRpcMock.openUserSession.mockReset()
  userRpcMock.closeUserSession.mockReset()
  userRpcMock.listWorkspaces.mockReset()
  userRpcMock.createWorkspace.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("WorkspaceSwitcher creation failure privacy", () => {
  it("keeps an uncertain workspace create generic and refreshes or switches only after confirmed success", async () => {
    const catalogStub = { label: "catalog" }
    const failedCreateStub = { label: "failed-create" }
    const successfulCreateStub = { label: "successful-create" }
    const refreshedCatalogStub = { label: "refreshed-catalog" }
    userRpcMock.openUserSession
      .mockReturnValueOnce(catalogStub)
      .mockReturnValueOnce(failedCreateStub)
      .mockReturnValueOnce(successfulCreateStub)
      .mockReturnValueOnce(refreshedCatalogStub)
    userRpcMock.listWorkspaces.mockResolvedValue([catalogEntry])
    const privateDetail = "private workspace provider detail"
    const failedCreate = deferred<typeof createdWorkspace>()
    userRpcMock.createWorkspace
      .mockReturnValueOnce(failedCreate.promise)
      .mockResolvedValueOnce(createdWorkspace)
    const onSwitch = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const host = await mount(onSwitch)
    const input = host.querySelector<HTMLInputElement>("#workspace-switcher-new-title")
    const form = host.querySelector<HTMLFormElement>(".workspace-switcher-create")

    await act(async () => {
      setInput(input!, createdWorkspace.title)
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(userRpcMock.createWorkspace).toHaveBeenCalledTimes(1)
    expect(userRpcMock.createWorkspace).toHaveBeenCalledWith(failedCreateStub, createdWorkspace.title)
    expect(input?.disabled).toBe(true)
    expect(host.querySelector(".workspace-switcher-create button")?.textContent).toBe("Creating…")
    expect(onSwitch).not.toHaveBeenCalled()
    expect(userRpcMock.listWorkspaces).toHaveBeenCalledTimes(1)

    await act(async () => {
      failedCreate.reject(new Error(privateDetail))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>(".workspace-switcher-manage [role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this workspace was created.")
    expect(alert?.textContent).toContain("The title is still here.")
    expect(alert?.textContent).toContain("Review your workspaces before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(input?.value).toBe(createdWorkspace.title)
    expect(input?.disabled).toBe(false)
    expect(onSwitch).not.toHaveBeenCalled()
    expect(userRpcMock.listWorkspaces).toHaveBeenCalledTimes(1)
    expect(userRpcMock.createWorkspace).toHaveBeenCalledTimes(1)
    expect(userRpcMock.closeUserSession).toHaveBeenCalledWith(failedCreateStub)
    expect(consoleError).toHaveBeenCalledWith(expect.any(Error))

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(input?.value).toBe("")
    expect(host.querySelector(".workspace-switcher-manage [role='alert']")).toBeNull()
    expect(userRpcMock.closeUserSession).toHaveBeenCalledWith(successfulCreateStub)
    expect(userRpcMock.createWorkspace).toHaveBeenCalledTimes(2)
    expect(userRpcMock.createWorkspace).toHaveBeenLastCalledWith(successfulCreateStub, createdWorkspace.title)
    expect(onSwitch).toHaveBeenCalledWith(createdWorkspace.workspaceId, createdWorkspace.title)
    expect(userRpcMock.listWorkspaces).toHaveBeenCalledTimes(2)
    expect(userRpcMock.openUserSession).toHaveBeenNthCalledWith(1, session.credential)
    expect(userRpcMock.openUserSession).toHaveBeenNthCalledWith(2, session.credential)
    expect(userRpcMock.openUserSession).toHaveBeenNthCalledWith(3, session.credential)
    expect(userRpcMock.openUserSession).toHaveBeenNthCalledWith(4, session.credential)
  })
})
