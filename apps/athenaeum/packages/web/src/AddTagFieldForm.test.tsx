/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))

import { AddTagFieldForm } from "./AddTagFieldForm.js"

const tagId = EntityId.make("00000000-0000-4000-8000-000000000003")
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (onAdded = vi.fn()): Promise<{ readonly host: HTMLDivElement; readonly onAdded: ReturnType<typeof vi.fn> }> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(
      <AddTagFieldForm
        tagId={tagId}
        nextSortOrder={4}
        surface="web-supertag-field-editor"
        onAdded={onAdded}
      />
    )
    await flush()
  })
  return { host, onAdded }
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const setSelect = (select: HTMLSelectElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event("change", { bubbles: true }))
}

const addButton = (host: HTMLDivElement): HTMLButtonElement | undefined =>
  host.querySelector<HTMLButtonElement>(".supertag-popover-add-field button") ?? undefined

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

describe("AddTagFieldForm mutation custody", () => {
  it("keeps a failed field draft retryable without exposing the transport detail", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const requestId = vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000010")
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private field definition provider detail"
    const { host, onAdded } = await mount()
    const name = host.querySelector<HTMLInputElement>("[aria-label='New field name']")
    const valueKind = host.querySelector<HTMLSelectElement>("[aria-label='New field type']")

    await act(async () => {
      setInput(name!, "Relationship")
      setSelect(valueKind!, "entity-ref")
      await flush()
    })
    expect(addButton(host)?.textContent).toBe("Add")

    await act(async () => {
      addButton(host)?.click()
      addButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(requestId).toHaveBeenCalledTimes(1)
    expect(addButton(host)?.disabled).toBe(true)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("Field couldn’t be added.")
    expect(alert?.textContent).toContain("Your field details are still here.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(name?.value).toBe("Relationship")
    expect(valueKind?.value).toBe("entity-ref")
    expect(addButton(host)?.textContent).toBe("Retry")
    expect(consoleError).toHaveBeenCalled()
    expect(onAdded).not.toHaveBeenCalled()

    await act(async () => {
      addButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(requestId).toHaveBeenCalledTimes(1)

    await act(async () => {
      observe?.(Exit.succeed({}))
      await flush()
    })
    expect(name?.value).toBe("")
    expect(valueKind?.value).toBe("text")
    expect(host.querySelector("[role='alert']")).toBeNull()
    expect(onAdded).toHaveBeenCalledTimes(1)
  })
})
