// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"
import { type PageDocumentDescriptor } from "@athenaeum/domain"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { EditorView } from "prosemirror-view"
import { loroSyncPluginKey } from "loro-prosemirror"

const runtimeMock = vi.hoisted(() => ({ runPromise: vi.fn() }))
const runtimeConnectionIdentityMock = vi.hoisted(() => ({ current: Object.freeze({}) }))
vi.mock("./runtime.js", () => ({
  runtime: runtimeMock,
  get runtimeConnectionIdentity() { return runtimeConnectionIdentityMock.current }
}))

import {
  createLoroEditorBinding,
  createPlanTodayEligibility,
  LoroRichNoteEditor
} from "./LoroRichNoteEditor.js"
import { createLoroPage } from "./loro-page.js"
import { firstPlanTodayPriorityPosition, PLAN_TODAY_STARTER } from "./plan-today-starter.js"
import { richTextSchemaAdapter } from "./rich-text/schema.js"
import type { LoroSemanticCustodySnapshot } from "./loro-semantic-custody.js"

const workspaceId = "00000000-0000-4000-8000-000000000071" as never
const nodeId = "00000000-0000-4000-8000-000000000072" as never

const testDescriptor = (id = nodeId, storageVersion = 1) => ({
  nodeId: id,
  storageVersion,
  activeFormat: "loro-v1" as const,
  loro: { schemaVersion: 1, snapshotSha256: "a".repeat(64) }
}) as unknown as Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>

const canonicalEmptyDocument = () => {
  const paragraph = richTextSchemaAdapter.schema.nodes.paragraph
  if (paragraph === undefined) throw new Error("test schema has no paragraph")
  return richTextSchemaAdapter.schema.topNodeType.create(null, [paragraph.create()])
}

const nonemptyDocument = () => {
  const paragraph = richTextSchemaAdapter.schema.nodes.paragraph
  if (paragraph === undefined) throw new Error("test schema has no paragraph")
  return richTextSchemaAdapter.schema.topNodeType.create(null, [paragraph.create(null, richTextSchemaAdapter.schema.text("already writing"))])
}

const snapshot = (overrides: Partial<LoroSemanticCustodySnapshot> = {}): LoroSemanticCustodySnapshot => ({
  token: "current",
  active: true,
  bindable: true,
  state: "clean",
  revision: 0,
  acceptedBase: { doc: createLoroPage().doc, descriptor: testDescriptor() },
  hasPostFreezeDraft: false,
  ...overrides
})

/** Wait for the real official-plugin init transaction rather than synthesizing a ready PM state. */
const flushOfficialLoroPluginInit = async (currentView: () => EditorView): Promise<EditorView> => {
  for (let round = 0; round < 8; round += 1) {
    const view = currentView()
    if (loroSyncPluginKey.getState(view.state)?.snapshot === null) return view
    await Promise.resolve()
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
    else await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error("official LoroSyncPlugin did not reach its snapshot-ready state")
}

describe("Plan Today eligibility", () => {
  it("accepts only the exact clean, current Loro attachment and rejects custody/descriptor drift", () => {
    const isPlanTodayEligible = createPlanTodayEligibility({
      offerPlanToday: true,
      nodeId,
      isCurrentUiAttachment: (candidate) => candidate.token === "current"
    })
    const empty = canonicalEmptyDocument()

    expect(isPlanTodayEligible(snapshot(), empty)).toBe(true)
    expect(isPlanTodayEligible(snapshot({
      acceptedBase: { doc: createLoroPage().doc, descriptor: testDescriptor("00000000-0000-4000-8000-000000000073" as never) }
    }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot({ token: "detached" }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot({ bindable: false }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot({ state: "retainedConflict" }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot({ state: "queued" }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot({ frozenA: {} as never }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot({ hasPostFreezeDraft: true }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot(), nonemptyDocument())).toBe(false)
    expect(isPlanTodayEligible(snapshot({
      acceptedBase: {
        doc: createLoroPage().doc,
        descriptor: { ...testDescriptor(), activeFormat: "plaintext-v1" } as never
      }
    }), empty)).toBe(false)
    expect(isPlanTodayEligible(snapshot({
      acceptedBase: { doc: createLoroPage().doc, descriptor: testDescriptor(nodeId, 2) }
    }), empty)).toBe(false)
  })
})

describe("Plan Today live editor binding", () => {
  it("renders and applies the shared manifest once, records one human edit, and selects/focuses the first priority", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const acceptedHumanEdit = vi.fn()
    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={workspaceId}
            nodeId={nodeId}
            initialPage={createLoroPage()}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={() => undefined}
            onSupertagApplied={() => undefined}
            onAcceptedHumanEdit={acceptedHumanEdit}
            onBindingReady={(next) => { binding = next }}
            offerPlanToday
          />
        )
      })
      await act(async () => { await flushOfficialLoroPluginInit(() => binding!.view!) })

      const action = host.querySelector(".daily-note-starter-action") as HTMLButtonElement | null
      expect(action?.textContent).toBe("Plan today")
      await act(async () => {
        action?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })

      expect(binding!.view!.state.doc.content.content.map((node) => ({
        type: node.type.name,
        level: node.type.name === "heading" ? node.attrs.level : undefined,
        text: node.textContent
      }))).toEqual([
        { type: "heading", level: 2, text: PLAN_TODAY_STARTER.focusHeading },
        ...PLAN_TODAY_STARTER.priorities.map((priority) => ({ type: "paragraph", level: undefined, text: priority })),
        { type: "heading", level: 2, text: PLAN_TODAY_STARTER.notesHeading },
        { type: "paragraph", level: undefined, text: "" }
      ])
      expect(acceptedHumanEdit).toHaveBeenCalledTimes(1)
      expect(binding!.view!.state.selection.from).toBe(firstPlanTodayPriorityPosition(binding!.view!.state.doc))
      expect(document.activeElement).toBe(binding!.view!.dom)
    } finally {
      await act(async () => { root.unmount() })
      host.remove()
      vi.useRealTimers()
    }
  })

  it("does not display or dispatch when the accepted descriptor belongs to a different node", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const acceptedHumanEdit = vi.fn()
    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={"00000000-0000-4000-8000-000000000074" as never}
            nodeId={nodeId}
            initialPage={createLoroPage()}
            initialDescriptor={testDescriptor("00000000-0000-4000-8000-000000000075" as never)}
            onSyncStatusChange={() => undefined}
            onSupertagApplied={() => undefined}
            onAcceptedHumanEdit={acceptedHumanEdit}
            onBindingReady={(next) => { binding = next }}
            offerPlanToday
          />
        )
      })
      await act(async () => { await flushOfficialLoroPluginInit(() => binding!.view!) })

      expect(host.querySelector(".daily-note-starter-action")).toBeNull()
      expect(binding!.applyPlanTodayStarter()).toBe(false)
      expect(acceptedHumanEdit).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })

  it("rejects a visible stale-attachment click synchronously before it can dispatch", async () => {
    vi.useFakeTimers()
    const host = document.createElement("div")
    const root = createRoot(host)
    const acceptedHumanEdit = vi.fn()
    const priorIdentity = runtimeConnectionIdentityMock.current
    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    try {
      runtimeMock.runPromise.mockReset()
      await act(async () => {
        root.render(
          <LoroRichNoteEditor
            workspaceId={"00000000-0000-4000-8000-000000000076" as never}
            nodeId={nodeId}
            initialPage={createLoroPage()}
            initialDescriptor={testDescriptor()}
            onSyncStatusChange={() => undefined}
            onSupertagApplied={() => undefined}
            onAcceptedHumanEdit={acceptedHumanEdit}
            onBindingReady={(next) => { binding = next }}
            offerPlanToday
          />
        )
      })
      await act(async () => { await flushOfficialLoroPluginInit(() => binding!.view!) })
      const action = host.querySelector(".daily-note-starter-action") as HTMLButtonElement | null
      expect(action).not.toBeNull()
      const before = binding!.view!.state.doc.toJSON()

      runtimeConnectionIdentityMock.current = Object.freeze({})
      await act(async () => {
        action?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })

      expect(binding!.view!.state.doc.toJSON()).toEqual(before)
      expect(acceptedHumanEdit).not.toHaveBeenCalled()
    } finally {
      runtimeConnectionIdentityMock.current = priorIdentity
      await act(async () => { root.unmount() })
      vi.useRealTimers()
    }
  })
})
