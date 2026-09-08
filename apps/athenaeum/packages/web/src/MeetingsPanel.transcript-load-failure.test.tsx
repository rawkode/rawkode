/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, MeetingNotFound, UnexpectedError, type Meeting } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  list: undefined as unknown,
  transcript: undefined as unknown,
  transcriptByGeneration: new Map<number, unknown>(),
  node: undefined as unknown,
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    if (dependencies.length === 1 && typeof dependencies[0] === "number") return queryStateMock.list
    if (dependencies.length === 2) {
      const generation = dependencies[1]
      return typeof generation === "number"
        ? queryStateMock.transcriptByGeneration.get(generation) ?? queryStateMock.transcript
        : queryStateMock.transcript
    }
    return queryStateMock.node
  }
}))
vi.mock("react-router", () => ({
  Link: ({ to, children }: { readonly to: string; readonly children?: ReactNode }) => <a href={to}>{children}</a>
}))

import { MeetingsPanel } from "./MeetingsPanel.js"

const meetingId = EntityId.make("00000000-0000-4000-8000-000000000001")
const speakerId = EntityId.make("00000000-0000-4000-8000-000000000002")
const linkedNodeId = EntityId.make("00000000-0000-4000-8000-000000000004")
const meeting = {
  id: meetingId,
  title: "One-to-one",
  startedAt: "2026-08-28T09:00:00.000Z",
  endedAt: "2026-08-28T09:30:00.000Z"
} as Meeting
const linkedMeeting = { ...meeting, linkedNodeId } as Meeting
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const buttonNamed = (host: HTMLDivElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

const transcriptQueries = (): ReadonlyArray<ReadonlyArray<unknown>> =>
  queryStateMock.dependencies.filter((dependencies) => dependencies.length === 2)

const transcriptGenerations = (): number[] => [
  ...new Set(
    transcriptQueries()
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<MeetingsPanel />)
    await flush()
  })
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return host
}

const rerender = async (host: HTMLDivElement): Promise<void> => {
  const root = roots.find((entry) => entry.host === host)?.root
  if (root === undefined) throw new Error("expected mounted MeetingsPanel root")
  await render(root)
}

const selectMeeting = async (host: HTMLDivElement): Promise<void> => {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".meetings-list-item-button")?.click()
    await flush()
  })
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.list = { status: "success" as const, value: { meetings: [meeting] } }
  queryStateMock.transcript = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal transcript retrieval detail" })
  }
  queryStateMock.transcriptByGeneration.clear()
  queryStateMock.node = { status: "success" as const, value: undefined }
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.list = undefined
  queryStateMock.transcript = undefined
  queryStateMock.transcriptByGeneration.clear()
  queryStateMock.node = undefined
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("MeetingsPanel transcript-load recovery", () => {
  it("keeps the selected meeting visible and retries only an unknown transcript read once at a time", async () => {
    const host = await mount()
    expect(host.querySelector(".meetings-list-item-button")?.getAttribute("aria-current")).toBeNull()
    await selectMeeting(host)
    const alert = host.querySelector<HTMLElement>(".meetings-load-state")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Transcript couldn’t be loaded.")
    expect(alert?.textContent).toContain("Nothing has been changed.")
    expect(host.textContent).not.toContain("Internal transcript retrieval detail")
    expect(host.querySelector(".meetings-list-item-button")?.textContent).toContain("One-to-one")
    expect(host.querySelector(".meetings-list-item-button")?.getAttribute("aria-current")).toBe("true")
    expect(transcriptQueries()).toEqual([[meetingId, 0]])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(transcriptGenerations()).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".meetings-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.transcriptByGeneration.set(1, { status: "loading" as const })
    await rerender(host)
    const loadingStatus = host.querySelector<HTMLElement>(".meetings-transcript-loading")
    expect(loadingStatus?.textContent).toContain("Loading transcript…")
    expect(loadingStatus?.getAttribute("role")).toBe("status")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.transcriptByGeneration.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Internal transcript retrieval detail" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".meetings-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(transcriptGenerations()).toEqual([0, 1, 2])
  })

  it("keeps a confirmed missing meeting distinct from a retryable transcript failure", async () => {
    queryStateMock.transcript = { status: "failure" as const, error: new MeetingNotFound({ meetingId }) }
    const host = await mount()
    await selectMeeting(host)
    const notice = host.querySelector<HTMLElement>(".meetings-load-state")

    expect(notice?.getAttribute("role")).toBe("status")
    expect(notice?.textContent).toContain("This meeting is no longer available.")
    expect(buttonNamed(host, "Retry")).toBeUndefined()
    expect(host.querySelector(".meetings-list-item-button")?.textContent).toContain("One-to-one")
  })

  it("keeps the successful transcript and speaker rendering unchanged", async () => {
    queryStateMock.transcript = {
      status: "success" as const,
      value: {
        meeting,
        speakers: [{ id: speakerId, label: "David" }],
        segments: [
          {
            id: EntityId.make("00000000-0000-4000-8000-000000000003"),
            startOffsetMs: 0,
            speakerId,
            text: "Follow up tomorrow.",
            source: "on-device"
          }
        ]
      }
    }
    const host = await mount()
    await selectMeeting(host)

    expect(host.querySelector(".meetings-transcript h3")?.textContent).toBe("One-to-one")
    expect(host.querySelector(".meetings-transcript-segment-speaker")?.textContent).toBe("David")
    expect(host.querySelector(".meetings-transcript-segment-text")?.textContent).toBe("Follow up tomorrow.")
    expect(host.querySelector(".meetings-load-state")).toBeNull()
  })

  it("keeps a linked note navigable when its title lookup fails without leaking the cause", async () => {
    const privateDetail = "private linked-note retrieval detail"
    queryStateMock.list = { status: "success" as const, value: { meetings: [linkedMeeting] } }
    queryStateMock.transcript = {
      status: "success" as const,
      value: {
        meeting: linkedMeeting,
        speakers: [],
        segments: []
      }
    }
    queryStateMock.node = {
      status: "failure" as const,
      error: new UnexpectedError({ message: privateDetail })
    }
    const host = await mount()
    await selectMeeting(host)

    const link = host.querySelector<HTMLAnchorElement>(".meetings-linked-node a")
    const status = host.querySelector<HTMLElement>(".meetings-linked-node-error")
    expect(link?.getAttribute("href")).toBe(`/node/${linkedNodeId}`)
    expect(link?.textContent).toContain(linkedNodeId)
    expect(status?.getAttribute("role")).toBe("status")
    expect(status?.textContent).toContain("Linked note title couldn’t be loaded.")
    expect(status?.textContent).toContain("The note link is still available.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(transcriptQueries()).toEqual([[meetingId, 0]])
  })
})
