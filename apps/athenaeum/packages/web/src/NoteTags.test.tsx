/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, WorkspaceNotFound } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  states: new Map<string, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    // The note-level tag list owns the only three-part dependency tuple. Field summaries have
    // their own two-part query, which stays empty here so this test exercises real chip rendering
    // without coupling it to field-value fetching.
    if (dependencies.length !== 3) return { status: "success", value: [] }
    const key = dependencies.map(String).join(":")
    return queryStateMock.states.get(key) ?? queryStateMock.current
  }
}))

import { NoteTags } from "./NoteTags.js"
import type { NoteTagChip } from "./NoteTags.js"
import type { FloatingAnchorRect, FloatingAnchorRectSource } from "./floating-popover-position.js"

const nodeId = EntityId.make("00000000-0000-4000-8000-000000000001")
const otherNodeId = EntityId.make("00000000-0000-4000-8000-000000000006")
const tagId = EntityId.make("00000000-0000-4000-8000-000000000002")
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const render = async (
  root: Root,
  refreshKey: number,
  onSelectTag: (
    chip: NoteTagChip,
    anchorRect: FloatingAnchorRect,
    anchorRectSource: FloatingAnchorRectSource
  ) => void,
  currentNodeId: EntityId = nodeId
): Promise<void> => {
  await act(async () => {
    root.render(<NoteTags nodeId={currentNodeId} refreshKey={refreshKey} onSelectTag={onSelectTag} />)
    await flush()
  })
}

const queryStateKey = (currentNodeId: EntityId, refreshKey: number, retryKey: number): string =>
  [currentNodeId, refreshKey, retryKey].map(String).join(":")

const mount = async (state: unknown, refreshKey = 7, currentNodeId: EntityId = nodeId) => {
  queryStateMock.current = state
  const onSelectTag = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root, refreshKey, onSelectTag, currentNodeId)
  return { root, host, onSelectTag }
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.states.clear()
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.current = undefined
  queryStateMock.states.clear()
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("NoteTags load recovery", () => {
  it("labels initial loading without making an empty-tag claim", async () => {
    const { host } = await mount({ status: "loading" })

    expect(host.querySelector<HTMLElement>(".note-tags")?.getAttribute("aria-busy")).toBe("true")
    expect(host.querySelector("[role=status]")?.textContent).toContain("Loading Supertags…")
    expect(host.querySelector(".note-tags-empty")).toBeNull()
    expect(host.querySelector(".note-tags-list")).toBeNull()
  })

  it("renders a generic retryable failure instead of an empty or raw domain-error state", async () => {
    const { host } = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })

    expect(host.querySelectorAll(".note-tags-load-state")).toHaveLength(1)
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Supertags could not be loaded.")
    expect(host.textContent).not.toContain("This workspace doesn't exist")
    expect(host.textContent).not.toContain("No Supertags yet")
    expect(host.querySelector(".note-tags-list")).toBeNull()
    expect(queryStateMock.dependencies).toEqual([[nodeId, 7, 0]])
  })

  it("retries the local tag-list query once at a time while retaining the caller refresh dependency", async () => {
    const { root, host, onSelectTag } = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    }, 11)
    const dependencyCountBeforeRetry = queryStateMock.dependencies.length

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".note-tags-load-state button")?.click()
      host.querySelector<HTMLButtonElement>(".note-tags-load-state button")?.click()
      await flush()
    })

    expect(queryStateMock.dependencies.slice(dependencyCountBeforeRetry)).toEqual([[nodeId, 11, 1]])
    expect(host.querySelector("[role=status]")?.textContent).toContain("Loading Supertags…")
    expect(host.querySelector<HTMLButtonElement>(".note-tags-load-state button")).toBeNull()

    queryStateMock.states.set(queryStateKey(nodeId, 11, 1), { status: "loading" })
    await render(root, 11, onSelectTag)
    expect(host.querySelector("[role=status]")?.textContent).toContain("Loading Supertags…")

    queryStateMock.states.set(queryStateKey(nodeId, 11, 1), {
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })
    await render(root, 11, onSelectTag)
    const releasedRetry = host.querySelector<HTMLButtonElement>(".note-tags-load-state button")
    expect(releasedRetry?.disabled).toBe(false)
    expect(releasedRetry?.textContent).toBe("Retry")
    const dependencyCountBeforeNextRetry = queryStateMock.dependencies.length

    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(queryStateMock.dependencies.slice(dependencyCountBeforeNextRetry)).toEqual([[nodeId, 11, 2]])
  })

  it("retains a confirmed tag snapshot through a refresh failure without exposing its cause", async () => {
    const { root, host, onSelectTag } = await mount({ status: "success", value: [{ tagId, name: "Person" }] }, 7)
    const refreshStateKey = queryStateKey(nodeId, 8, 0)

    queryStateMock.states.set(refreshStateKey, { status: "loading" })
    await render(root, 8, onSelectTag)

    const retainedChip = host.querySelector<HTMLButtonElement>(".note-tags-chip")
    expect(retainedChip?.textContent).toBe("#Person")
    expect(host.querySelector("[role=status]")?.textContent).toContain("Refreshing Supertags…")
    expect(host.querySelector<HTMLElement>(".note-tags")?.getAttribute("aria-busy")).toBe("true")
    await act(async () => {
      retainedChip?.click()
      await flush()
    })
    expect(onSelectTag).toHaveBeenCalledWith(
      { tagId, name: "Person" },
      expect.objectContaining({ top: expect.any(Number), left: expect.any(Number) }),
      expect.any(Function)
    )

    const privateDetail = "private tag provider endpoint"
    queryStateMock.states.set(refreshStateKey, { status: "failure", error: new Error(privateDetail) })
    await render(root, 8, onSelectTag)

    expect(host.querySelector<HTMLButtonElement>(".note-tags-chip")?.textContent).toBe("#Person")
    expect(host.querySelector("[role=alert]")?.textContent).toContain("existing Supertags remain available")
    expect(host.textContent).not.toContain(privateDetail)
  })

  it("replaces the snapshot only after a current success and never carries it to another node", async () => {
    const { root, host, onSelectTag } = await mount({ status: "success", value: [{ tagId, name: "Person" }] }, 7)
    const refreshStateKey = queryStateKey(nodeId, 8, 0)

    queryStateMock.states.set(refreshStateKey, { status: "loading" })
    await render(root, 8, onSelectTag)
    queryStateMock.states.set(refreshStateKey, { status: "success", value: [] })
    await render(root, 8, onSelectTag)

    expect(host.querySelector(".note-tags-chip")).toBeNull()
    expect(host.textContent).toContain("No Supertags yet")

    await render(root, 8, onSelectTag, otherNodeId)
    expect(host.querySelector(".note-tags-chip")).toBeNull()
    expect(host.textContent).not.toContain("No Supertags yet")
    expect(host.querySelector("[role=status]")?.textContent).toContain("Loading Supertags…")
  })

  it("keeps the successful empty and chip-selection paths intact", async () => {
    const empty = await mount({ status: "success", value: [] })
    expect(empty.host.querySelector(".note-tags-load-state")).toBeNull()
    expect(empty.host.textContent).toContain("No Supertags yet")

    const populated = await mount({ status: "success", value: [{ tagId, name: "Person" }] })
    const chip = populated.host.querySelector<HTMLButtonElement>(".note-tags-chip")
    expect(chip?.textContent).toBe("#Person")
    await act(async () => {
      chip?.click()
      await flush()
    })
    expect(populated.onSelectTag).toHaveBeenCalledWith(
      { tagId, name: "Person" },
      expect.objectContaining({ top: expect.any(Number), left: expect.any(Number) }),
      expect.any(Function)
    )
  })
})
