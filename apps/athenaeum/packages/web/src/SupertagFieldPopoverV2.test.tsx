/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EntityId, ResolvedTagField } from "@athenaeum/domain"

const runtimeMock = vi.hoisted(() => ({ runPromise: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byRefreshKey: new Map<number, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.byRefreshKey.get(Number(dependencies[2])) ?? queryStateMock.current
  }
}))

import { SupertagFieldPopover } from "./SupertagFieldPopoverV2.js"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const nodeId = "00000000-0000-4000-8000-000000000002" as EntityId
const tagId = "00000000-0000-4000-8000-000000000003" as EntityId
const fieldId = "00000000-0000-4000-8000-000000000004" as EntityId
const factId = "00000000-0000-4000-8000-000000000005" as EntityId

const resolvedField = {
  field: {
    id: fieldId,
    name: "Email",
    valueKind: "text"
  },
  inherited: false
} as unknown as ResolvedTagField

const successState = {
  status: "success",
  value: {
    fields: [resolvedField],
    factByPredicateId: new Map()
  }
}

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []

afterEach(() => {
  vi.clearAllMocks()
  queryStateMock.current = undefined
  queryStateMock.byRefreshKey.clear()
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
})

const mount = async (
  onClose = vi.fn(),
  onSaved = vi.fn(),
  queryState: unknown = successState,
  tagOverrides: Partial<{
    readonly anchorRect: {
      readonly top: number
      readonly right: number
      readonly bottom: number
      readonly left: number
      readonly width: number
      readonly height: number
    }
  }> = {}
) => {
  queryStateMock.current = queryState
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  const render = async () => {
    await act(async () => {
      root.render(
        <SupertagFieldPopover
          nodeId={nodeId}
          tag={{ tagId, name: "Person", ...tagOverrides }}
          onClose={onClose}
          onSaved={onSaved}
        />
      )
      await flush()
    })
  }
  await render()
  return { host, onClose, onSaved, render }
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const fieldRefreshGenerations = (): ReadonlyArray<number> =>
  [...new Set(queryStateMock.dependencies.map((dependencies) => dependencies[2]))].filter(
    (generation): generation is number => typeof generation === "number"
  )

describe("SupertagFieldPopover", () => {
  it("anchors to the invoking chip instead of falling back to the stylesheet corner", async () => {
    const { host } = await mount(vi.fn(), vi.fn(), successState, {
      anchorRect: { top: 700, right: 760, bottom: 724, left: 700, width: 60, height: 24 }
    })
    const popover = host.querySelector<HTMLElement>(".supertag-popover")
    expect(popover).not.toBeNull()

    vi.spyOn(popover!, "getBoundingClientRect").mockReturnValue({
      top: 0,
      right: 320,
      bottom: 180,
      left: 0,
      width: 320,
      height: 180,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 })

    await act(async () => {
      window.dispatchEvent(new Event("resize"))
      await flush()
    })

    expect(popover?.dataset.placement).toBe("above")
    expect(popover?.style.top).toBe("510px")
    expect(popover?.style.left).toBe("700px")
    expect(popover?.style.right).toBe("auto")
    expect(popover?.style.bottom).toBe("auto")
  })

  it("commits a field on plain Enter and exposes the saved result", async () => {
    runtimeMock.runPromise.mockResolvedValue({ fact: { id: factId } })
    const { host, onSaved } = await mount()
    const field = host.querySelector<HTMLInputElement>("#supertag-field-" + fieldId)
    expect(field).not.toBeNull()

    await act(async () => {
      setInput(field!, "person@example.com")
      field?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      await flush()
    })

    expect(runtimeMock.runPromise).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(host.querySelector(".supertag-field-status")?.textContent).toContain("✓ Saved")
  })

  it("closes on idle Escape but leaves an editor-owned Escape alone", async () => {
    const onClose = vi.fn()
    const { host } = await mount(onClose)

    await act(async () => {
      const prevented = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      prevented.preventDefault()
      document.dispatchEvent(prevented)
      await flush()
    })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await flush()
    })
    expect(host.querySelector("[role='dialog']")).not.toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("shows a generic retryable load failure without inventing an empty schema and retries only one matching field read at a time", async () => {
    const { host, render } = await mount(
      vi.fn(),
      vi.fn(),
      { status: "failure", error: new Error("private provider endpoint rejected the request") }
    )

    const alert = host.querySelector<HTMLElement>(".supertag-popover-load-state")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Fields couldn’t be loaded.")
    expect(host.textContent).not.toContain("private provider endpoint")
    expect(host.querySelector(".supertag-popover-empty")).toBeNull()
    expect(host.querySelector(".supertag-popover-fields")).toBeNull()
    expect(host.querySelector("[aria-label='New field name']")).toBeNull()
    expect(fieldRefreshGenerations()).toEqual([0])

    await act(async () => {
      const retry = alert?.querySelector<HTMLButtonElement>("button")
      retry?.click()
      retry?.click()
      await flush()
    })

    expect(fieldRefreshGenerations()).toEqual([0, 1])
    expect(host.querySelector<HTMLButtonElement>(".supertag-popover-load-state button")?.textContent).toBe("Retrying…")
    expect(host.querySelector<HTMLButtonElement>(".supertag-popover-load-state button")?.disabled).toBe(true)
    expect(queryStateMock.dependencies.every((dependencies) =>
      dependencies.length === 3 && dependencies[0] === nodeId && dependencies[1] === tagId
    )).toBe(true)

    queryStateMock.byRefreshKey.set(1, { status: "loading" })
    await render()
    expect(host.querySelector(".supertag-popover-load-state")).toBeNull()
    const loadingStatus = host.querySelector<HTMLElement>(".supertag-popover-loading")
    expect(loadingStatus?.textContent).toBe("Loading fields…")
    expect(loadingStatus?.getAttribute("role")).toBe("status")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.byRefreshKey.set(1, {
      status: "failure",
      error: new Error("private retry field provider detail")
    })
    await render()

    const releasedRetry = host.querySelector<HTMLButtonElement>(".supertag-popover-load-state button")
    expect(releasedRetry?.textContent).toBe("Retry")
    expect(releasedRetry?.disabled).toBe(false)
    expect(host.textContent).not.toContain("private retry field provider detail")
    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(fieldRefreshGenerations()).toEqual([0, 1, 2])
  })

  it("retains loaded fields and a dirty draft when their refresh fails", async () => {
    const { host, render } = await mount()
    const field = host.querySelector<HTMLInputElement>("#supertag-field-" + fieldId)
    expect(field).not.toBeNull()

    await act(async () => {
      setInput(field!, "retain@example.com")
      await flush()
    })

    queryStateMock.current = { status: "loading" }
    await render()

    const refreshingStatus = host.querySelector<HTMLElement>(".supertag-popover-loading")
    expect(refreshingStatus?.textContent).toBe("Refreshing fields…")
    expect(refreshingStatus?.getAttribute("role")).toBe("status")
    expect(refreshingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(refreshingStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector<HTMLInputElement>("#supertag-field-" + fieldId)?.value).toBe("retain@example.com")

    queryStateMock.current = {
      status: "failure",
      error: new Error("private graph facts failure")
    }
    await render()

    const alert = host.querySelector<HTMLElement>(".supertag-popover-load-state")
    expect(alert?.textContent).toContain("Fields couldn’t be refreshed.")
    expect(host.textContent).not.toContain("private graph facts failure")
    expect(host.querySelector<HTMLInputElement>("#supertag-field-" + fieldId)?.value).toBe("retain@example.com")
    expect(host.querySelector("[aria-label='New field name']")).not.toBeNull()
    expect(host.querySelector(".supertag-popover-empty")).toBeNull()
  })

  it("holds the popover and Add Field controls through a close drain, then saves and closes once", async () => {
    const accepted = deferred<{ readonly fact: { readonly id: EntityId } }>()
    runtimeMock.runPromise.mockReturnValue(accepted.promise)
    const { host, onClose, onSaved } = await mount()
    const field = host.querySelector<HTMLInputElement>("#supertag-field-" + fieldId)
    const close = host.querySelector<HTMLButtonElement>(".supertag-popover-close")
    const addField = host.querySelector<HTMLInputElement>("[aria-label='New field name']")
    expect(field).not.toBeNull()
    expect(close).not.toBeNull()
    expect(addField).not.toBeNull()

    await act(async () => {
      setInput(field!, "person@example.com")
      close?.click()
      await flush()
    })

    expect(runtimeMock.runPromise).toHaveBeenCalledTimes(1)
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(field?.disabled).toBe(true)
    expect(addField?.disabled).toBe(true)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await flush()
    })
    expect(onClose).not.toHaveBeenCalled()

    accepted.resolve({ fact: { id: factId } })
    await act(async () => { await flush() })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps the failed close draft visible and retryable instead of unmounting it", async () => {
    const first = deferred<{ readonly fact: { readonly id: EntityId } }>()
    const retry = deferred<{ readonly fact: { readonly id: EntityId } }>()
    const privateDetail = "private field mutation provider detail"
    runtimeMock.runPromise
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise)
    const { host, onClose, onSaved } = await mount()
    const field = host.querySelector<HTMLInputElement>("#supertag-field-" + fieldId)
    const close = host.querySelector<HTMLButtonElement>(".supertag-popover-close")

    await act(async () => {
      setInput(field!, "retry@example.com")
      close?.click()
      first.reject(new Error(privateDetail))
      await flush()
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(field?.value).toBe("retry@example.com")
    const retryButton = host.querySelector<HTMLButtonElement>(".supertag-field-retry")
    expect(retryButton?.textContent).toBe("Retry")
    const failure = host.querySelector<HTMLElement>(".supertag-field-error")
    expect(failure?.getAttribute("role")).toBe("alert")
    expect(failure?.textContent).toContain("couldn’t confirm that this field was saved")
    expect(host.textContent).not.toContain(privateDetail)

    await act(async () => {
      retryButton?.click()
      retry.resolve({ fact: { id: factId } })
      await flush()
    })

    expect(runtimeMock.runPromise).toHaveBeenCalledTimes(2)
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps a failed removal open and suppresses private transport details", async () => {
    const privateDetail = "private tag removal provider detail"
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    runtimeMock.runPromise.mockRejectedValueOnce(new Error(privateDetail))
    const { host, onClose, onSaved } = await mount()
    const remove = host.querySelector<HTMLButtonElement>(".supertag-popover-remove")

    await act(async () => {
      remove?.click()
      await flush()
    })

    const failure = host.querySelector<HTMLElement>(".supertag-popover-remove-error")
    expect(failure?.getAttribute("role")).toBe("alert")
    expect(failure?.textContent).toContain("couldn’t confirm that this tag was removed")
    expect(host.textContent).not.toContain(privateDetail)
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector("[role='dialog']")).not.toBeNull()
    expect(consoleError).toHaveBeenCalledWith(expect.any(Error))
    consoleError.mockRestore()
  })
})
