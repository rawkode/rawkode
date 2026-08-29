/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  state: undefined as unknown
}))

const editorMock = vi.hoisted(() => ({
  setStatus: undefined as undefined | ((status: "idle" | "syncing" | "synced" | "error" | "conflict") => void),
  setRetry: undefined as undefined | ((retry: (() => void) | undefined) => void)
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: () => queryStateMock.state
}))
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("./LoroRichNoteEditor.js", () => ({
  LoroRichNoteEditor: (props: {
    readonly onSyncStatusChange: (status: "idle" | "syncing" | "synced" | "error" | "conflict") => void
    readonly onSyncRetryReady?: (retry: (() => void) | undefined) => void
  }) => {
    editorMock.setStatus = props.onSyncStatusChange
    editorMock.setRetry = props.onSyncRetryReady
    return null
  }
}))
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

const successState = () => ({
  status: "success" as const,
  value: {
    nodeId: "00000000-0000-4000-8000-000000000001" as never,
    format: "loro-v1" as const,
    page: {} as never,
    descriptor: { activeFormat: "loro-v1" } as never
  }
})

const mount = async (todayBriefTargetId?: string): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<DailyNote date={date} onNavigateDate={vi.fn()} todayBriefTargetId={todayBriefTargetId} />)
    await flush()
  })
  return host
}

const setStatus = async (status: "idle" | "syncing" | "synced" | "error" | "conflict"): Promise<void> => {
  await act(async () => {
    editorMock.setStatus?.(status)
    await flush()
  })
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.state = successState()
  editorMock.setStatus = undefined
  editorMock.setRetry = undefined
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("DailyNote sync status", () => {
  it("offers a current-day jump to the brief when the route provides a target", async () => {
    const host = await mount("today-brief")

    const link = host.querySelector<HTMLAnchorElement>(".daily-note-brief-jump")
    expect(link?.textContent).toBe("Today’s brief")
    expect(link?.getAttribute("href")).toBe("#today-brief")
  })

  it("keeps idle and synced states silent without reserving a status row", async () => {
    const host = await mount()

    expect(host.querySelector(".sync-status")).toBeNull()
    expect(host.textContent).not.toContain("Ready")
    expect(host.textContent).not.toContain("Synced")

    await setStatus("idle")
    expect(host.querySelector(".sync-status")).toBeNull()

    await setStatus("synced")
    expect(host.querySelector(".sync-status")).toBeNull()
  })

  it("shows active syncing work without presenting it as an error", async () => {
    const host = await mount()

    await setStatus("syncing")

    const status = host.querySelector<HTMLElement>(".sync-status-syncing")
    expect(status?.textContent).toContain("Syncing…")
    expect(status?.getAttribute("role")).toBe("status")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
    expect(status?.querySelector(".sync-status-dot")).not.toBeNull()
  })

  it("preserves the retryable error notice and makes sync retries single-flight", async () => {
    const host = await mount()
    const retry = vi.fn(() => editorMock.setStatus?.("syncing"))

    await act(async () => {
      editorMock.setRetry?.(retry)
      editorMock.setStatus?.("error")
      await flush()
    })

    const alert = host.querySelector<HTMLElement>(".sync-status-error")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Sync failed — your local changes are still here.")
    const button = alert?.querySelector<HTMLButtonElement>(".sync-status-retry")
    expect(button?.textContent).toBe("Retry")

    await act(async () => {
      button?.click()
      button?.click()
      await flush()
    })
    expect(retry).toHaveBeenCalledTimes(1)
    const retryingButton = host.querySelector<HTMLButtonElement>(".sync-status-retry")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    await setStatus("error")
    const releasedButton = host.querySelector<HTMLButtonElement>(".sync-status-retry")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it("keeps conflicts prominent and never exposes a stale generic retry action", async () => {
    const host = await mount()

    await act(async () => {
      editorMock.setRetry?.(vi.fn())
      editorMock.setStatus?.("conflict")
      await flush()
    })

    const alert = host.querySelector<HTMLElement>(".sync-status-conflict")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Conflict — your local draft is preserved.")
    expect(alert?.querySelector(".sync-status-retry")).toBeNull()
  })
})
