/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError, type App } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: () => ({
    status: "success" as const,
    value: { codeVersion: { code: "const persisted = true" } }
  })
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

const mount = async (onChanged: () => void): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<AppDetail app={app} onChanged={onChanged} />)
    await flush()
  })
  return host
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

const saveButton = (host: HTMLDivElement): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent === "Save client code" || button.textContent === "Saving…")

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppDetail code-save custody", () => {
  it("keeps an uncertain save generic and retains the local draft", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const onChanged = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private app code write provider detail"
    const draft = "const localDraft = true"
    const host = await mount(onChanged)
    const editor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='client code']")

    await act(async () => {
      setInput(editor!, draft)
      setReason(host, "Save the local client draft.")
      saveButton(host)?.click()
      saveButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(saveButton(host)?.textContent).toBe("Saving…")
    expect(saveButton(host)?.disabled).toBe(true)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this code was saved.")
    expect(alert?.textContent).toContain("Your draft is still here.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(editor?.value).toBe(draft)
    expect(onChanged).not.toHaveBeenCalled()
    expect(saveButton(host)?.disabled).toBe(false)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      saveButton(host)?.click()
      saveButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })

  it("clears the draft and notifies the owner only after a confirmed save", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const onChanged = vi.fn()
    const host = await mount(onChanged)
    const editor = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='client code']")

    await act(async () => {
      setInput(editor!, "const localDraft = true")
      setReason(host, "Persist the client fixture.")
      saveButton(host)?.click()
      await flush()
      observe?.(Exit.succeed(undefined))
      await flush()
    })

    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(editor?.value).toBe("const persisted = true")
    expect(host.querySelector("[role='alert']")).toBeNull()
  })
})
