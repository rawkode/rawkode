/** @vitest-environment happy-dom */

import { act, useEffect, type ReactNode } from "react"
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
vi.mock("./Backlinks.js", () => ({
  Backlinks: () => <section className="backlinks"><h2>Backlinks</h2></section>
}))
vi.mock("./WorkforceAttentionStrip.js", () => ({
  WorkforceAttentionStrip: () => <section className="workforce-attention-strip" />
}))
vi.mock("./NoteTags.js", () => ({ NoteTags: () => null }))
vi.mock("./SupertagFieldPopover.js", () => ({
  SupertagFieldPopover: () => null
}))
vi.mock("./LedgerActivityPanel.js", () => ({
  DAILY_STANDUP_ANCHOR_ID: "daily-standup-title",
  DailyStandup: ({ standup }: { readonly standup?: { readonly snapshot?: { readonly isToday?: boolean } } }) =>
    standup?.snapshot?.isToday === true
      ? <section id="daily-standup-title" className="daily-standup-subdocument"><h2>Daily standup</h2></section>
      : null
}))

import { DailyNote } from "./DailyNote.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
const date = new Date(2000, 0, 2, 12)
const contextLifecycle = { mounted: 0, unmounted: 0 }

function ContextSentinel() {
  useEffect(() => {
    contextLifecycle.mounted += 1
    return () => { contextLifecycle.unmounted += 1 }
  }, [])
  return <div data-testid="daily-context">Calendar context</div>
}

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

const renderNote = async (
  root: Root,
  todayBriefTargetId?: string,
  dailyContext?: ReactNode,
  noteDate: Date = date
): Promise<void> => {
  await act(async () => {
    root.render(<DailyNote date={noteDate} onNavigateDate={vi.fn()} todayBriefTargetId={todayBriefTargetId} dailyContext={dailyContext} />)
    await flush()
  })
}

const mountWithRoot = async (
  todayBriefTargetId?: string,
  dailyContext?: ReactNode,
  noteDate: Date = date
): Promise<{ readonly host: HTMLDivElement; readonly root: Root }> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await renderNote(root, todayBriefTargetId, dailyContext, noteDate)
  return { host, root }
}

const mount = async (todayBriefTargetId?: string, dailyContext?: ReactNode, noteDate: Date = date): Promise<HTMLDivElement> =>
  (await mountWithRoot(todayBriefTargetId, dailyContext, noteDate)).host

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
  contextLifecycle.mounted = 0
  contextLifecycle.unmounted = 0
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("DailyNote sync status", () => {
  it("keeps Today as the shell identity and hides ordinary implementation chrome", async () => {
    const host = await mount(undefined, undefined, new Date())
    const header = host.querySelector<HTMLElement>(".daily-note-header")

    expect(header?.classList.contains("daily-note-header-today")).toBe(true)
    expect(header?.querySelector(".daily-note-title")).toBeNull()
    expect(header?.querySelector(".daily-note-format")).toBeNull()
    expect(header?.querySelector("time")).not.toBeNull()
  })

  it("offers a current-day jump to the brief when the route provides a target", async () => {
    const host = await mount("today-brief")

    const link = host.querySelector<HTMLAnchorElement>(".daily-note-brief-jump")
    expect(link?.textContent).toBe("Today’s brief")
    expect(link?.getAttribute("href")).toBe("#today-brief")
  })

  it("offers a current-day jump to the standup once the note is resolved", async () => {
    const host = await mount(undefined, undefined, new Date())

    const link = host.querySelector<HTMLAnchorElement>(".daily-note-standup-jump")
    expect(link?.textContent).toBe("Review standup")
    expect(link?.getAttribute("href")).toBe("#daily-standup-title")
  })

  it("keeps one neutral workspace with writing before the single contextual brief", async () => {
    const host = await mount(undefined, <div data-testid="daily-context">Calendar context</div>)
    const workspace = host.querySelector<HTMLElement>(".daily-note-workspace")
    const editor = host.querySelector<HTMLElement>(".daily-note-editor")
    const header = editor?.querySelector<HTMLElement>(".daily-note-header")
    const canvas = editor?.querySelector<HTMLElement>(".daily-note-canvas")
    const context = workspace?.children.item(1) as HTMLElement | null

    expect(workspace).not.toBeNull()
    expect(Array.from(workspace?.children ?? [])).toEqual([editor, context])
    expect(workspace?.querySelectorAll(".daily-note-context")).toHaveLength(1)
    expect(context?.querySelector("[data-testid='daily-context']")?.textContent).toBe("Calendar context")

    const children = editor ? Array.from(editor.children) : []
    expect(children.indexOf(header!)).toBeLessThan(children.indexOf(canvas!))
    expect(workspace?.children[0]).toBe(editor)
    expect(workspace?.children[1]).toBe(context)
  })

  it("keeps standup and backlinks outside the companion workspace", async () => {
    const host = await mount(undefined, <div data-testid="daily-context">Calendar context</div>)
    const workspace = host.querySelector(".daily-note-workspace")
    const standup = host.querySelector(".daily-standup-subdocument")
    const backlinks = host.querySelector(".backlinks")

    expect(workspace?.contains(standup)).toBe(false)
    expect(workspace?.contains(backlinks)).toBe(false)
  })

  it("keeps the complete Today reading order and unique anchors", async () => {
    const host = await mount("today-brief", <div id="today-brief"><h2>Today&rsquo;s brief</h2></div>, new Date())
    const note = host.querySelector<HTMLElement>(".daily-note")
    const workspace = host.querySelector<HTMLElement>(".daily-note-workspace")
    const editor = workspace?.children[0] as HTMLElement | undefined
    const context = workspace?.children[1] as HTMLElement | undefined
    const header = editor?.querySelector<HTMLElement>(".daily-note-header")
    const attention = editor?.querySelector<HTMLElement>(".workforce-attention-strip")
    const canvas = editor?.querySelector<HTMLElement>(".daily-note-canvas")
    const standup = note?.querySelector<HTMLElement>(".daily-standup-subdocument")
    const backlinks = note?.querySelector<HTMLElement>(".backlinks")

    expect(Array.from(workspace?.children ?? [])).toEqual([editor, context])
    const editorChildren = editor ? Array.from(editor.children) : []
    expect(editorChildren.indexOf(header!)).toBeLessThan(editorChildren.indexOf(attention!))
    expect(editorChildren.indexOf(attention!)).toBeLessThan(editorChildren.indexOf(canvas!))
    const noteChildren = note ? Array.from(note.children) : []
    expect(noteChildren.indexOf(workspace!)).toBeLessThan(noteChildren.indexOf(standup!))
    expect(noteChildren.indexOf(standup!)).toBeLessThan(noteChildren.indexOf(backlinks!))
    expect(host.querySelectorAll("#today-brief")).toHaveLength(1)
    expect(host.querySelectorAll("#daily-standup-title")).toHaveLength(1)
    const noteHeading = note?.querySelector("h1")
    const briefHeading = host.querySelector("#today-brief h2")
    const standupHeading = standup?.querySelector("h2")
    expect(noteHeading).not.toBeNull()
    expect(briefHeading).not.toBeNull()
    expect(standupHeading).not.toBeNull()
    expect(noteHeading!.compareDocumentPosition(briefHeading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(briefHeading!.compareDocumentPosition(standupHeading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("omits optional context and Today-only attention for historical notes", async () => {
    const host = await mount(undefined, <div data-testid="historical-context">Historical context</div>)

    expect(host.querySelector(".daily-note-context")).not.toBeNull()
    expect(host.querySelector(".workforce-attention-strip")).toBeNull()
    expect(host.querySelector(".daily-note-standup-jump")).toBeNull()
    expect(host.querySelector(".daily-standup-subdocument")).toBeNull()
    expect(host.querySelector(".backlinks")).not.toBeNull()
    expect(host.querySelector(".daily-note-header")?.classList.contains("daily-note-header-today")).toBe(false)
  })

  it("omits the optional context wrapper when no projection is supplied", async () => {
    const host = await mount()

    expect(host.querySelector(".daily-note-context")).toBeNull()
    expect(host.querySelector(".daily-note-workspace")?.children).toHaveLength(1)
  })

  it("keeps one context instance through resolver loading, failure, retry, and success", async () => {
    const context = <ContextSentinel />
    const mounted = await mountWithRoot(undefined, context, new Date())
    expect(contextLifecycle.mounted).toBe(1)

    queryStateMock.state = { status: "loading" as const }
    await renderNote(mounted.root, undefined, context, new Date())
    queryStateMock.state = { status: "failure" as const, error: new Error("unavailable") }
    await renderNote(mounted.root, undefined, context, new Date())
    expect(mounted.host.querySelector(".daily-note-resolution-error")).not.toBeNull()
    await act(async () => {
      mounted.host.querySelector<HTMLButtonElement>(".daily-note-resolution-error button")?.click()
      await flush()
    })
    queryStateMock.state = successState()
    await renderNote(mounted.root, undefined, context, new Date())

    expect(contextLifecycle.mounted).toBe(1)
    expect(contextLifecycle.unmounted).toBe(0)
    expect(mounted.host.querySelectorAll(".daily-note-context")).toHaveLength(1)
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
