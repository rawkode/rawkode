/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ValidationError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  outcomes: new Map<number, "loading" | "failure">()
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    const retryKey = dependencies[1]
    const outcome = typeof retryKey === "number" ? queryStateMock.outcomes.get(retryKey) ?? "failure" : "loading"
    if (outcome === "loading") return { status: "loading" as const }
    return {
      status: "failure" as const,
      error: new ValidationError({ message: "Internal resolver detail" })
    }
  }
}))
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("./LoroRichNoteEditor.js", () => ({ LoroRichNoteEditor: () => null }))
vi.mock("./Backlinks.js", () => ({ Backlinks: () => null }))
vi.mock("./NoteTags.js", () => ({ NoteTags: () => null }))
vi.mock("./SupertagFieldPopover.js", () => ({ SupertagFieldPopover: () => null }))
vi.mock("./LedgerActivityPanel.js", () => ({ DailyStandup: () => null }))

import { DailyNote } from "./DailyNote.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const date = new Date(2000, 0, 2, 12)

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<DailyNote date={date} onNavigateDate={vi.fn()} />)
    await flush()
  })
}

const mount = async (): Promise<{ readonly root: Root; readonly host: HTMLDivElement }> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return { root, host }
}

const resolveRetryKeys = (): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.dependencies = []
  queryStateMock.outcomes.clear()
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("DailyNote resolution failure", () => {
  it("keeps the primary canvas readable and retries the existing resolve query only once at a time", async () => {
    const { root, host } = await mount()
    const canvas = host.querySelector<HTMLElement>(".daily-note-canvas-failure")

    expect(canvas?.getAttribute("role")).toBe("alert")
    expect(canvas?.textContent).toContain("Daily note is unavailable")
    expect(canvas?.textContent).toContain("Retry to continue loading this date safely.")
    expect(canvas?.textContent).not.toContain("Internal resolver detail")
    expect(host.querySelector(".daily-note-resolution-error")).not.toBeNull()
    expect(resolveRetryKeys()).toEqual([0])

    await act(async () => {
      canvas?.querySelector<HTMLButtonElement>("button")?.click()
      canvas?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(resolveRetryKeys()).toEqual([0, 1])
    const claimedRetry = host.querySelector<HTMLButtonElement>(".daily-note-resolution-error button")
    expect(claimedRetry?.disabled).toBe(true)
    expect(claimedRetry?.textContent).toBe("Retrying…")

    queryStateMock.outcomes.set(1, "loading")
    await render(root)
    expect(host.querySelector(".daily-note-canvas-loading")).not.toBeNull()

    queryStateMock.outcomes.set(1, "failure")
    await render(root)
    const releasedRetry = host.querySelector<HTMLButtonElement>(".daily-note-resolution-error button")
    expect(releasedRetry?.disabled).toBe(false)
    expect(releasedRetry?.textContent).toBe("Retry")

    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(resolveRetryKeys()).toEqual([0, 1, 2])
  })
})
