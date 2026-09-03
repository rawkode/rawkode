/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError, type App } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byKind: new Map<string, unknown>(),
  byKindAndGeneration: new Map<string, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: { runFork: vi.fn() } }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    const key = `${String(dependencies[1])}:${String(dependencies[2])}`
    return queryStateMock.byKindAndGeneration.get(key) ?? queryStateMock.byKind.get(String(dependencies[1])) ?? queryStateMock.current
  }
}))
vi.mock("./AppRunFrame.js", () => ({ AppRunFrame: () => <output data-app-preview /> }))

import { AppDetail } from "./AppLibraryPanel.js"

const appId = EntityId.make("00000000-0000-4000-8000-000000000001")
const app = {
  id: appId,
  title: "Counter",
  icon: "✦",
  serverCodeVersion: 2,
  clientCodeVersion: 4,
  revision: 3,
  acceptedRevision: 3,
  updatedAt: "2026-08-28T12:00:00.000Z"
} as App
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const renderDetail = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<AppDetail app={app} onChanged={vi.fn()} />)
    await flush()
  })
}

const mount = async (): Promise<{ readonly host: HTMLDivElement; readonly root: Root }> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await renderDetail(root)
  return { host, root }
}

const setInput = (input: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const setReason = (host: HTMLDivElement, value: string): void => {
  const input = host.querySelector<HTMLInputElement>("[aria-label='Save client code commit message']")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input?.dispatchEvent(new Event("input", { bubbles: true }))
}

const buttonNamed = (host: HTMLDivElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

const codeGenerations = (kind: "client" | "server"): ReadonlyArray<number> =>
  [...new Set(queryStateMock.dependencies.filter((dependencies) => dependencies[1] === kind).map((dependencies) => dependencies[2]))].filter(
    (generation): generation is number => typeof generation === "number"
  )

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal code source detail" })
  }
  queryStateMock.byKind.clear()
  queryStateMock.byKindAndGeneration.clear()
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.current = undefined
  queryStateMock.byKind.clear()
  queryStateMock.byKindAndGeneration.clear()
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppDetail code-load custody", () => {
  it("never turns an unknown code load failure into a blank writable editor and retries only that read once at a time", async () => {
    const { host, root } = await mount()
    const alert = host.querySelector<HTMLElement>(".app-code-load-state")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Client code couldn’t be loaded.")
    expect(alert?.textContent).toContain("Retry before editing or saving code.")
    expect(host.textContent).not.toContain("Internal code source detail")
    expect(host.querySelector("textarea")).toBeNull()
    expect(host.textContent).not.toContain("Save client code")
    expect(codeGenerations("client")).toEqual([0])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(codeGenerations("client")).toEqual([0, 1])
    expect(buttonNamed(host, "Retrying…")?.disabled).toBe(true)

    queryStateMock.byKindAndGeneration.set("client:1", { status: "loading" as const })
    await renderDetail(root)
    const status = host.querySelector<HTMLElement>("[role=status]")
    expect(status?.textContent).toBe("Loading client code…")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector("textarea")).toBeNull()

    queryStateMock.byKindAndGeneration.set("client:1", {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Private retry failure" })
    })
    await renderDetail(root)

    const releasedRetry = buttonNamed(host, "Retry")
    expect(releasedRetry?.disabled).toBe(false)
    expect(host.textContent).not.toContain("Private retry failure")
    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(codeGenerations("client")).toEqual([0, 1, 2])
  })

  it("keeps the known no-code case editable", async () => {
    queryStateMock.current = { status: "failure" as const, error: { _tag: "AppCodeVersionNotFound" } }
    const { host } = await mount()
    const editor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='client code']")

    expect(host.querySelector(".app-code-load-state")).toBeNull()
    expect(editor?.value).toBe("")
    expect(editor?.readOnly).toBe(false)
    await act(async () => {
      if (editor) setInput(editor, "const newClientCode = true")
      setReason(host, "Create the client code fixture.")
      await flush()
    })
    expect(editor?.value).toBe("const newClientCode = true")
    expect(buttonNamed(host, "Save client code")?.disabled).toBe(false)
  })

  it("retains a loaded snapshot read-only through a later failed reload", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: { codeVersion: { code: "const persisted = true" } }
    }
    const { host, root } = await mount()
    const editor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='client code']")
    expect(editor?.value).toBe("const persisted = true")

    queryStateMock.current = {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Private reload failure" })
    }
    await renderDetail(root)

    expect(host.querySelector(".app-code-load-state")?.textContent).toContain("Current content is kept read-only")
    expect(editor?.value).toBe("const persisted = true")
    expect(editor?.readOnly).toBe(true)
    expect(host.textContent).not.toContain("Private reload failure")
  })

  it("retains a local draft read-only through a later failed reload", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: { codeVersion: { code: "const persisted = true" } }
    }
    const { host, root } = await mount()
    const editor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='client code']")
    expect(editor?.value).toBe("const persisted = true")

    await act(async () => {
      if (editor) setInput(editor, "const localDraft = true")
      await flush()
    })
    expect(editor?.value).toBe("const localDraft = true")

    queryStateMock.current = {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Private reload failure" })
    }
    await renderDetail(root)

    expect(host.querySelector(".app-code-load-state")?.textContent).toContain("Current content is kept read-only")
    expect(editor?.value).toBe("const localDraft = true")
    expect(editor?.readOnly).toBe(true)
    expect(host.textContent).not.toContain("Private reload failure")
    expect(buttonNamed(host, "Save client code")?.disabled).toBe(true)
  })

  it("does not carry an unsaved Client draft into the Server editor", async () => {
    queryStateMock.byKind.set("client", {
      status: "success" as const,
      value: { codeVersion: { code: "const clientCode = true" } }
    })
    queryStateMock.byKind.set("server", {
      status: "success" as const,
      value: { codeVersion: { code: "export default { fetch() {} }" } }
    })
    const { host } = await mount()
    const clientEditor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='client code']")

    await act(async () => {
      if (clientEditor) setInput(clientEditor, "const unsavedClientDraft = true")
      await flush()
    })
    expect(clientEditor?.value).toBe("const unsavedClientDraft = true")

    await act(async () => {
      host.querySelector<HTMLButtonElement>("button[role=tab][aria-selected='false']")?.click()
      await flush()
    })

    const serverEditor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='server code']")
    expect(serverEditor?.value).toBe("export default { fetch() {} }")
    expect(serverEditor?.value).not.toContain("unsavedClientDraft")
  })
})
