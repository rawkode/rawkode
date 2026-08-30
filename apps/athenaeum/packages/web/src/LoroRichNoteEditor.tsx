import { useEffect, useRef, useState } from "react"
import { LoroSyncPlugin, LoroUndoPlugin, loroSyncPluginKey, redo, undo, type LoroDocType } from "loro-prosemirror"
import * as Effect from "effect/Effect"
import { EditorState, type Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { CommitLoroPageContentInput, GetPageDocumentDescriptorInput, HumanUiMutationAttribution, IanaTimeZone, LoroMutationIntentV1, PrepareMeetingInDailyNoteInput, type EntityId, type LocalDate, type PageDocumentDescriptor, type PrepareMeetingInDailyNoteOutput } from "@athenaeum/domain"
import { runtime, runtimeConnectionIdentity } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import {
  LORO_PROSEMIRROR_CONTAINER,
  loroPagePmContainerId,
  convergeLoroPageFromServer,
  inspectLoroPage,
  type LoroPageDocument,
} from "./loro-page.js"
import { CheckpointedLoroWriter, DAILY_NOTE_SEMANTIC_DEBOUNCE_MS } from "./checkpointed-loro-writer.js"
import type { AcceptedLoroBase, FrozenLoroIntent } from "./checkpointed-loro-writer.js"
import { updateEditorEmptyState } from "./rich-text/editor-empty-state.js"
import {
  isTerminalLoroRequestIdentityError,
  loroSemanticCustodyRegistry,
  type LoroCheckpointTransportResult,
  type LoroSemanticCustodySnapshot
} from "./loro-semantic-custody.js"
import { richTextSchemaAdapter } from "./rich-text/schema.js"
import { makeNoteEditorSupport } from "./rich-text/editor-support.js"
import type { SupertagCandidate } from "./rich-text/supertag-plugin.js"
import type { FloatingAnchorRect, FloatingAnchorRectSource } from "./floating-popover-position.js"
import { TaskItemView } from "./rich-text/task-item-node-view.js"
import "./rich-text/rich-text.css"

const SYNC_DEBOUNCE_MS = DAILY_NOTE_SEMANTIC_DEBOUNCE_MS
const SYNC_BACKGROUND_RETRY_DELAYS_MS = [100, 250, 500] as const
/** Effect-local UI projection cadence. Semantic custody never holds a React continuation. */
export const LORO_CUSTODY_PRESENTATION_POLL_MS = 50
type SyncStatus = "idle" | "syncing" | "synced" | "error" | "conflict"

/**
 * A semantic checkpoint may originate only from an unowned local PM transaction. The official
 * LoroSyncPlugin marks all of its `update-state`, `doc-changed`, and `non-local-updates`
 * transactions with its PluginKey; treating *any* ownership value as ineligible avoids relying
 * on a guessed string discriminator and keeps plugin initialization/imports off the ledger path.
 */
export const isHumanLoroDocumentTransaction = (transaction: Transaction): boolean => {
  const pluginOwnership = transaction.getMeta(loroSyncPluginKey)
  return transaction.docChanged && pluginOwnership === undefined
}

const isTerminalRequestIdentityError = isTerminalLoroRequestIdentityError

/**
 * Debounce and serialize one editor's sync operations. The queue keeps the dirty bit separate
 * from the in-flight operation so an edit arriving during a request is flushed after that
 * request, with the same mutable document and session handle.
 */
export const createSerializedLoroSyncQueue = (
  run: () => Promise<void>,
  debounceMs = SYNC_DEBOUNCE_MS
): {
  schedule: () => void
  scheduleInternal: () => void
  flush: () => Promise<void>
  cancel: () => void
  dispose: () => Promise<void>
} => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let latestScheduledGeneration = 0
  let claimedGeneration: number | undefined
  let disposed = false
  let closing = false
  let closePromise: Promise<void> | undefined
  let chain = Promise.resolve()
  let backgroundRetryAttempt = 0

  const scheduleBackgroundRetry = (): void => {
    if (
      disposed ||
      !pending ||
      timer !== undefined ||
      backgroundRetryAttempt >= SYNC_BACKGROUND_RETRY_DELAYS_MS.length
    ) return
    const delay = SYNC_BACKGROUND_RETRY_DELAYS_MS[backgroundRetryAttempt]
    backgroundRetryAttempt += 1
    timer = setTimeout(() => {
      timer = undefined
      void flush().catch(() => {
        scheduleBackgroundRetry()
      })
    }, delay)
  }

  const runDebouncedSync = (): void => {
    void flush().catch(() => {
      scheduleBackgroundRetry()
    })
  }

  const flush = (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!pending) return chain
    const operationGeneration = latestScheduledGeneration
    pending = false
    claimedGeneration = operationGeneration
    const operation = async (): Promise<void> => {
      try {
        await run()
      } catch (error) {
        // A newer generation may already have claimed the pending work while this
        // operation was in flight. Only the claim that failed may restore itself;
        // otherwise an old failure can resurrect work already consumed by a newer run.
        if (claimedGeneration === operationGeneration) {
          claimedGeneration = undefined
          if (latestScheduledGeneration === operationGeneration) pending = true
        }
        throw error
      } finally {
        if (claimedGeneration === operationGeneration) claimedGeneration = undefined
      }
    }
    chain = chain.then(operation, operation)
    return chain
  }

  const schedule = (internal = false): void => {
    if (disposed || (closing && !internal)) return
    pending = true
    latestScheduledGeneration += 1
    backgroundRetryAttempt = 0
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      runDebouncedSync()
    }, closing ? 0 : debounceMs)
  }

  const cancel = (): void => {
    pending = false
    backgroundRetryAttempt = 0
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const dispose = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    // Close the UI ingress but keep the single queue alive long enough for a frozen A, its retry,
    // and any already-recorded B to settle. Coordinator-generated B uses scheduleInternal().
    closing = true
    closePromise = (async () => {
      let teardownRetries = 0
      while (true) {
        try {
          await flush()
        } catch {
          if (!pending || teardownRetries >= 1) break
          teardownRetries += 1
          continue
        }
        // A completion can schedule B after `flush()` began. Drain it before final disposal.
        if (!pending && timer === undefined) break
      }
      disposed = true
    })()
    return closePromise
  }

  return { schedule: () => schedule(), scheduleInternal: () => schedule(true), flush, cancel, dispose }
}

export type { LoroCheckpointTransportResult } from "./loro-semantic-custody.js"

/**
 * The node-lifetime semantic coordinator. It is deliberately independent of React so its A/B
 * custody, retry, and conflict behavior can be proved with injected transport and timers.
 */
export class LoroSemanticCheckpointCoordinator {
  readonly writer: CheckpointedLoroWriter
  #postFreezeDirty = false
  #conflicted = false
  #terminal = false
  #closing = false
  readonly #queue: ReturnType<typeof createSerializedLoroSyncQueue>

  constructor(options: {
    readonly writer: CheckpointedLoroWriter
    readonly intent: () => LoroMutationIntentV1
    readonly transport: (flight: FrozenLoroIntent) => Promise<LoroCheckpointTransportResult>
    readonly onFreeze: () => void
    readonly onAccepted: () => void
    readonly onConflict: () => void
    readonly onError: (error: unknown) => void
    readonly debounceMs?: number
  }) {
    this.writer = options.writer
    this.#queue = createSerializedLoroSyncQueue(async () => {
      if (this.#conflicted || this.#terminal) return
      const isNewBatch = this.writer.inFlight === undefined
      const flight = this.writer.inFlight ?? this.writer.freeze(options.intent())
      if (isNewBatch) options.onFreeze()
      try {
        const result = await options.transport(flight)
        this.writer.accept(result.authoritative, result.receipt)
        options.onAccepted()
        if (this.#postFreezeDirty) {
          this.#postFreezeDirty = false
          this.#queue.scheduleInternal()
        }
      } catch (error) {
        if (typeof error === "object" && error !== null && (error as { _tag?: string })._tag === "LoroContentConflict") {
          this.writer.rejectConflict()
          this.#conflicted = true
          this.#queue.cancel()
          options.onConflict()
          return
        }
        if (isTerminalRequestIdentityError(error)) {
          this.#terminal = true
          this.#queue.cancel()
          options.onError(error)
          return
        }
        options.onError(error)
        throw error
      }
    }, options.debounceMs)
  }

  get conflicted(): boolean { return this.#conflicted }
  get terminal(): boolean { return this.#terminal }

  /** Called only for a user-eligible PM change. B is recorded but never runs alongside A. */
  noteHumanEdit(): void {
    if (this.#conflicted || this.#terminal || this.#closing) return
    if (this.writer.inFlight !== undefined) {
      this.#postFreezeDirty = true
      return
    }
    this.#queue.schedule()
  }

  retry(): void {
    if (this.#conflicted || this.#terminal || this.#closing) return
    this.#queue.schedule()
    void this.#queue.flush().catch(() => undefined)
  }

  recoverAfterExplicitAuthorityReload(): void {
    if (!this.#conflicted) throw new Error("Loro conflict recovery was requested outside conflict state")
    this.#postFreezeDirty = false
    this.#conflicted = false
  }

  flush(): Promise<void> { return this.#queue.flush() }
  /** Navigation/unmount closes UI ingress but drains frozen A and already-recorded B custody. */
  dispose(): Promise<void> {
    this.#closing = true
    return this.#queue.dispose()
  }
}

export interface LoroRichNoteEditorProps {
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly initialPage: LoroPageDocument
  readonly initialDescriptor: Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>
  readonly onSyncStatusChange: (status: SyncStatus) => void
  readonly onSyncRetryReady?: (retry: (() => void) | undefined) => void
  readonly onSupertagApplied: (
    candidate: SupertagCandidate,
    anchorRect: FloatingAnchorRect,
    anchorRectSource?: FloatingAnchorRectSource
  ) => void
  readonly autoFocus?: boolean
  readonly onOpenEntityRef?: (nodeId: string) => void
  /** Integration seam for host lifecycle observation; undefined means this node's binding closed. */
  readonly onBindingReady?: (binding: ReturnType<typeof createLoroEditorBinding> | undefined) => void
  /** Registers a server-owned meeting-preparation command while this Loro attachment is live. */
  readonly onPrepareMeetingReady?: (prepare: PrepareMeetingHandler | undefined) => void
  /** Called only after a matching receipt has been reconciled through current authority. */
  readonly onPreparationCompleted?: (receipt: PrepareMeetingInDailyNoteOutput) => void
  readonly onAcceptedHumanEdit?: () => void
}

export type PrepareMeetingRequest = {
  readonly localDate: LocalDate
  readonly timeZone: IanaTimeZone
  readonly occurrenceKey: string
  readonly commitMessage: string
}

export type PrepareMeetingHandler = (request: PrepareMeetingRequest) => Promise<PrepareMeetingInDailyNoteOutput>

export const isMatchingMeetingPreparationReceipt = (
  receipt: PrepareMeetingInDailyNoteOutput,
  nodeId: EntityId,
  localDate: LocalDate,
  occurrenceKey: string
): boolean => receipt.dailyNoteId === nodeId && receipt.localDate === localDate && receipt.occurrenceKey === occurrenceKey

export const isAuthoritativeMeetingPreparationReload = (args: {
  readonly current: boolean
  readonly clean: boolean
  readonly descriptorNodeId: EntityId | undefined
  readonly nodeId: EntityId
}): boolean => args.current && args.clean && args.descriptorNodeId === args.nodeId

/** Visible terminal-conflict affordance; dismissal is deliberately an explicit destructive choice. */
export function LoroConflictNotice({
  state,
  onDiscardAndReload
}: {
  readonly state: "conflict" | "requestIdentity" | "resolving" | "externalCommitFailed"
  readonly onDiscardAndReload: () => void
}) {
  const reloadable = state === "conflict" || state === "requestIdentity" || state === "externalCommitFailed"
  return (
    <p className="sync-status sync-status-error" role="alert" aria-live="assertive">
      {state === "resolving"
        ? "Reloading authoritative note…"
        : state === "externalCommitFailed"
          ? "The note changed outside this editor, but the authoritative reload failed."
        : state === "requestIdentity"
          ? "This edit request cannot be retried safely. Your local draft is preserved."
          : "This note changed elsewhere. Your local draft is preserved."}
      {reloadable && (
        <button type="button" className="sync-status-retry" onClick={onDiscardAndReload}>
          {state === "externalCommitFailed" ? "Retry authoritative reload" : "Reload and discard local draft"}
        </button>
      )}
    </p>
  )
}

/**
 * Owns the live official-plugin view for a coordinator. Rebinding destroys only the view/support
 * pair; the coordinator and its serialized queue intentionally survive across A -> B -> authority+B.
 */
export const createLoroEditorBinding = (options: {
  readonly container: HTMLElement
  /** Compatibility path for focused coordinator tests; production uses the custody attachment below. */
  readonly writer?: CheckpointedLoroWriter
  readonly coordinator?: LoroSemanticCheckpointCoordinator
  /** Current attachment draft. Rebinding reads this only while its token is current/bindable. */
  readonly getWorkingDraft?: () => import("loro-crdt/bundler").LoroDoc
  /** Called only after the official-plugin ownership gate accepted a local PM transaction. */
  readonly onHumanEdit?: () => void
  /** A stale attachment/runtime makes an old live view noneditable before React remounts it. */
  readonly isAttachmentActive?: () => boolean
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly onSupertagApplied: (
    candidate: SupertagCandidate,
    anchorRect: FloatingAnchorRect,
    anchorRectSource?: FloatingAnchorRectSource
  ) => void
  readonly onOpenEntityRef?: (nodeId: string) => void
  readonly autoFocus?: boolean
}) => {
  let view: EditorView | undefined
  let support: ReturnType<typeof makeNoteEditorSupport> | undefined
  // LoroSyncPlugin initializes the actual PM document on a zero-delay owned transaction. Keep
  // the browser surface noneditable until its documented `snapshot === null` ready sentinel,
  // otherwise a user could type B into the temporary empty PM state immediately after A freezes.
  let semanticReadOnly = false
  const editable = (state: EditorState): boolean =>
    !semanticReadOnly &&
    options.isAttachmentActive?.() !== false &&
    loroSyncPluginKey.getState(state)?.snapshot === null
  const lockStaleView = (currentView: EditorView): void => {
    if (options.isAttachmentActive?.() !== false) return
    // `editable` is a dynamic predicate, but ProseMirror only reflects it into the DOM during a
    // view update. Force that update at the first stale DOM/dispatch boundary so an old
    // contenteditable surface cannot accept input after a runtime/attachment scope switch.
    semanticReadOnly = true
    currentView.setProps({ editable })
  }
  const rebind = (): void => {
    view?.destroy()
    support?.dispose()
    const workingDraft = options.getWorkingDraft?.() ?? options.writer?.workingDraft
    if (workingDraft === undefined) throw new Error("Loro editor binding has no current working draft")
    const page = inspectLoroPage(workingDraft)
    support = makeNoteEditorSupport({
      workspaceId: options.workspaceId,
      nodeId: options.nodeId,
      schema: richTextSchemaAdapter.schema,
      onSupertagApplied: options.onSupertagApplied,
      keymapHistory: { includeHistory: false, undo, redo }
    })
    const initialDoc = richTextSchemaAdapter.schema.topNodeType.createAndFill()
    if (initialDoc === null) throw new Error("Rich-text schema cannot create an empty document")
    const state = EditorState.create({
      schema: richTextSchemaAdapter.schema,
      doc: initialDoc,
      plugins: [
        LoroSyncPlugin({ doc: page.doc as LoroDocType, containerId: loroPagePmContainerId(page) }),
        LoroUndoPlugin({ doc: page.doc }),
        ...support.plugins
      ]
    })
    const editorView = new EditorView(options.container, {
      state,
      editable,
      nodeViews: {
        task_item: (node, currentView, getPos) =>
          new TaskItemView(node, currentView, getPos as () => number | undefined)
      },
      handleClick(clickView, pos, event) {
        if (!(event.metaKey || event.ctrlKey)) return false
        const clicked = clickView.state.doc.nodeAt(pos)
        const mark = clicked ? richTextSchemaAdapter.schema.marks.entityRef.isInSet(clicked.marks) : undefined
        if (mark && typeof mark.attrs.nodeId === "string" && mark.attrs.nodeId.length > 0 && options.onOpenEntityRef !== undefined) {
          options.onOpenEntityRef(mark.attrs.nodeId)
          return true
        }
        return false
      },
      dispatchTransaction: (transaction) => {
        const currentView = view
        if (currentView === undefined) return
        if (options.isAttachmentActive?.() === false) {
          lockStaleView(currentView)
          return
        }
        currentView.updateState(currentView.state.apply(transaction))
        updateEditorEmptyState(currentView)
        if (!isHumanLoroDocumentTransaction(transaction)) return
        support!.scheduleReferenceSync(currentView)
        support!.scheduleSupertagSync(currentView)
        if (options.onHumanEdit !== undefined) options.onHumanEdit()
        else options.coordinator?.noteHumanEdit()
      },
      handleDOMEvents: {
        beforeinput: (currentView, event) => {
          if (options.isAttachmentActive?.() !== false) return false
          event.preventDefault()
          lockStaleView(currentView)
          return true
        },
        keydown: (currentView, event) => {
          if (options.isAttachmentActive?.() !== false) return false
          event.preventDefault()
          lockStaleView(currentView)
          return true
        },
        paste: (currentView, event) => {
          if (options.isAttachmentActive?.() !== false) return false
          event.preventDefault()
          lockStaleView(currentView)
          return true
        },
        drop: (currentView, event) => {
          if (options.isAttachmentActive?.() !== false) return false
          event.preventDefault()
          lockStaleView(currentView)
          return true
        },
        compositionstart: (currentView, event) => {
          if (options.isAttachmentActive?.() !== false) return false
          event.preventDefault()
          lockStaleView(currentView)
          return true
        }
      }
    })
    view = editorView
    editorView.dom.setAttribute("role", "textbox")
    editorView.dom.setAttribute("aria-label", "Daily note editor")
    editorView.dom.setAttribute("aria-multiline", "true")
    updateEditorEmptyState(editorView)
    support.seedProjectionBaselines(editorView.state.doc)
    if (options.autoFocus === true) {
      const active = document.activeElement
      if (active === null || active === document.body) editorView.focus()
    }
  }
  rebind()
  return {
    rebind,
    setSemanticReadOnly: (readOnly: boolean) => {
      semanticReadOnly = readOnly
      view?.setProps({ editable })
    },
    dispose: () => {
      support?.dispose()
      view?.destroy()
    },
    get view(): EditorView | undefined { return view }
  }
}

/**
 * ProseMirror editor backed by the official Loro binding. React owns only a tokenized attachment
 * and disposable view. The runtime-scoped custody registry owns all A/B/timer/retry state, so a
 * route change never cancels a semantic checkpoint or lets an old attachment rebind a new view.
 */
export function LoroRichNoteEditor({
  workspaceId,
  nodeId,
  initialPage,
  initialDescriptor,
  onSyncStatusChange,
  onSyncRetryReady,
  onSupertagApplied,
  autoFocus,
  onOpenEntityRef,
  onBindingReady,
  onPrepareMeetingReady,
  onPreparationCompleted,
  onAcceptedHumanEdit
}: LoroRichNoteEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const latestStatusCallback = useRef(onSyncStatusChange)
  const latestRetryRegistration = useRef(onSyncRetryReady)
  const latestSupertagAppliedCallback = useRef(onSupertagApplied)
  const latestOpenEntityRefCallback = useRef(onOpenEntityRef)
  const latestAutoFocus = useRef(autoFocus)
  const resolveConflictRef = useRef<(() => void) | undefined>(undefined)
  const reloadExternalCommitRef = useRef<(() => void) | undefined>(undefined)
  const attachmentGenerationRef = useRef(0)
  const [conflictState, setConflictState] = useState<"none" | "conflict" | "requestIdentity" | "resolving" | "externalCommitFailed">("none")
  latestStatusCallback.current = onSyncStatusChange
  latestRetryRegistration.current = onSyncRetryReady
  latestSupertagAppliedCallback.current = onSupertagApplied
  latestOpenEntityRefCallback.current = onOpenEntityRef
  latestAutoFocus.current = autoFocus
  const routeKey = `${workspaceId}:${nodeId}:${initialDescriptor.nodeId}:${initialDescriptor.storageVersion}:${initialDescriptor.loro.schemaVersion}:${initialDescriptor.loro.snapshotSha256}`
  // Capture both values at render/effect entry. `runtimeConnectionIdentity` changes atomically
  // with `switchWorkspaceConnection`, so an old UI token is inert even before React remounts.
  const renderedRuntime = runtime
  const renderedRuntimeConnectionIdentity = runtimeConnectionIdentity

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const retryRegistration = onSyncRetryReady
    const bindingReady = onBindingReady
    const preparationReady = onPrepareMeetingReady
    const preparationCompleted = onPreparationCompleted
    const acceptedHumanEdit = onAcceptedHumanEdit
    // Never reread the mutable runtime export here: a workspace/auth switch between render and
    // effect must not attach A under one runtime identity and send it through another.
    const scopedRuntime = renderedRuntime
    const scopedRuntimeConnectionIdentity = renderedRuntimeConnectionIdentity
    const lifecycle = { active: true }
    const generation = attachmentGenerationRef.current + 1
    attachmentGenerationRef.current = generation

    // A workspace/auth switch can occur between render and this effect. There is no safe scope
    // to attach in that interval; the next render owns any replacement attachment.
    if (runtime !== scopedRuntime || runtimeConnectionIdentity !== scopedRuntimeConnectionIdentity) {
      return () => {
        lifecycle.active = false
        if (attachmentGenerationRef.current === generation) attachmentGenerationRef.current += 1
        retryRegistration?.(undefined)
        preparationReady?.(undefined)
        setConflictState("none")
        bindingReady?.(undefined)
      }
    }

    const attachment = loroSemanticCustodyRegistry.attach({
      runtime: renderedRuntime as unknown as object,
      runtimeConnectionIdentity: scopedRuntimeConnectionIdentity,
      workspaceId,
      nodeId,
      initial: { doc: initialPage.doc, descriptor: initialDescriptor },
      debounceMs: SYNC_DEBOUNCE_MS,
      makeIntent: () => new LoroMutationIntentV1({
        requestId: crypto.randomUUID(), commitMessage: "Edit daily note",
        attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
      }),
      transport: async (flight) => scopedRuntime.runPromise(WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => Effect.flatMap(
          client.commitLoroPageContent(new CommitLoroPageContentInput({
            workspaceId, nodeId, intent: flight.intent,
            expectedStorageVersion: flight.expectedStorageVersion,
            expectedSnapshotSha256: flight.expectedSnapshotSha256,
            expectedVersionVector: flight.expectedVersionVector, update: flight.update
          })),
          (receipt) => Effect.map(convergeLoroPageFromServer(client, workspaceId, nodeId), (authority) => {
            const descriptor = receipt.descriptor
            if (descriptor.activeFormat !== "loro-v1") throw new Error("Loro receipt returned a non-Loro descriptor")
            return { authoritative: { doc: authority, descriptor }, receipt }
          })
        ))
      )),
      loadAuthority: async () => scopedRuntime.runPromise(WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => Effect.flatMap(
          client.getPageDocumentDescriptor(new GetPageDocumentDescriptorInput({ workspaceId, nodeId })),
          (result) => Effect.map(convergeLoroPageFromServer(client, workspaceId, nodeId), (doc) => {
            if (result.descriptor.activeFormat !== "loro-v1" || result.descriptor.nodeId !== nodeId) {
              throw new Error("authority reload returned a different daily note")
            }
            return { workspaceId, nodeId, doc, descriptor: result.descriptor }
          })
        ))
      ))
    })

    let binding: ReturnType<typeof createLoroEditorBinding> | undefined
    let boundDraft: LoroSemanticCustodySnapshot["workingDraft"]
    let latestRevision = attachment.snapshot().revision
    let presentationTimer: ReturnType<typeof setTimeout> | undefined
    const isCurrentUiScope = (): boolean =>
      lifecycle.active &&
      attachmentGenerationRef.current === generation &&
      runtime === scopedRuntime &&
      runtimeConnectionIdentity === scopedRuntimeConnectionIdentity
    const isCurrentUiAttachment = (snapshot: LoroSemanticCustodySnapshot): boolean =>
      isCurrentUiScope() &&
      attachment.active &&
      snapshot.active &&
      snapshot.token === attachment.token
    const isAttachmentUiLive = (): boolean =>
      isCurrentUiScope() && attachment.active

    const prepareMeeting: PrepareMeetingHandler = async ({ localDate, timeZone, occurrenceKey, commitMessage }) => {
      const before = attachment.snapshot()
      if (!isCurrentUiAttachment(before) || before.state !== "clean" || !before.bindable) {
        throw new Error("The daily note is not ready for meeting preparation")
      }
      if (!attachment.beginExternalCommit()) throw new Error("The daily note is busy with another mutation")
      presentSnapshot(attachment.snapshot())
      try {
        const result = await scopedRuntime.runPromise(WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.prepareMeetingInDailyNote(new PrepareMeetingInDailyNoteInput({
            workspaceId,
            dailyNoteId: nodeId,
            localDate,
            timeZone,
            occurrenceKey,
            intent: new LoroMutationIntentV1({
              requestId: crypto.randomUUID(),
              commitMessage,
              attribution: new HumanUiMutationAttribution({
                version: "athenaeum.mutation-attribution.v1",
                kind: "humanUi",
                surface: "rich-text-editor"
              })
            })
          })))
        ))
        if (!isMatchingMeetingPreparationReceipt(result, nodeId, localDate, occurrenceKey)) {
          throw new Error("meeting preparation receipt did not match the active daily note")
        }
        const reloaded = await attachment.reloadAfterExternalCommit()
        presentSnapshot(attachment.snapshot())
        if (!reloaded) throw new Error("Meeting preparation was committed, but the daily note could not be refreshed")
        const after = attachment.snapshot()
        if (!isAuthoritativeMeetingPreparationReload({
          current: isCurrentUiAttachment(after), clean: after.state === "clean",
          descriptorNodeId: after.acceptedBase?.descriptor.nodeId, nodeId
        })) {
          throw new Error("meeting preparation reload did not restore the active daily note")
        }
        binding?.view?.focus()
        preparationCompleted?.(result)
        return result
      } catch (error) {
        // A transport can fail after the Worker committed. Reconcile from server authority before
        // surfacing the error; custody remains read-only if that reconciliation cannot complete.
        await attachment.reloadAfterExternalCommit()
        presentSnapshot(attachment.snapshot())
        throw error
      }
    }

    const retrySync = () => {
      const beforeRetry = attachment.snapshot()
      if (!isCurrentUiAttachment(beforeRetry)) return
      if (attachment.manualRetry()) presentSnapshot(attachment.snapshot())
    }
    const resolveConflict = () => {
      const beforeRecovery = attachment.snapshot()
      if (!isCurrentUiAttachment(beforeRecovery)) return
      void attachment.discardAndReload().then(() => {
        // The recovery result may arrive after detach/navigation. Only the live token that
        // initiated it may present its result; custody itself remains independent of the view.
        const afterRecovery = attachment.snapshot()
        if (isCurrentUiAttachment(afterRecovery)) presentSnapshot(afterRecovery)
      })
    }
    const retryExternalCommit = () => {
      const beforeRetry = attachment.snapshot()
      if (!isCurrentUiAttachment(beforeRetry)) return
      void attachment.reloadAfterExternalCommit().then(() => {
        const afterRetry = attachment.snapshot()
        if (isCurrentUiAttachment(afterRetry)) presentSnapshot(afterRetry)
      })
    }

    const presentSnapshot = (snapshot: LoroSemanticCustodySnapshot): void => {
      if (!isCurrentUiAttachment(snapshot)) return
      latestRevision = snapshot.revision
      if (binding !== undefined && snapshot.bindable && snapshot.workingDraft !== undefined && snapshot.workingDraft !== boundDraft) {
        boundDraft = snapshot.workingDraft
        binding.rebind()
      }
      switch (snapshot.state) {
        case "clean":
          binding?.setSemanticReadOnly(false)
          setConflictState("none")
          latestRetryRegistration.current?.(undefined)
          latestStatusCallback.current(snapshot.revision === 0 ? "idle" : "synced")
          break
        case "externalCommit":
          binding?.setSemanticReadOnly(true)
          setConflictState("none")
          latestRetryRegistration.current?.(undefined)
          latestStatusCallback.current("syncing")
          break
        case "externalCommitFailed":
          binding?.setSemanticReadOnly(true)
          setConflictState("externalCommitFailed")
          latestRetryRegistration.current?.(retryExternalCommit)
          latestStatusCallback.current("error")
          break
        case "queued":
        case "inFlight":
          binding?.setSemanticReadOnly(false)
          setConflictState("none")
          latestRetryRegistration.current?.(undefined)
          latestStatusCallback.current("syncing")
          break
        case "retainedRetry":
          binding?.setSemanticReadOnly(true)
          setConflictState("none")
          latestRetryRegistration.current?.(retrySync)
          latestStatusCallback.current("error")
          break
        case "retainedConflict":
          binding?.setSemanticReadOnly(true)
          setConflictState("conflict")
          latestRetryRegistration.current?.(undefined)
          latestStatusCallback.current("conflict")
          break
        case "retainedRequestIdentity":
          binding?.setSemanticReadOnly(true)
          setConflictState("requestIdentity")
          latestRetryRegistration.current?.(undefined)
          latestStatusCallback.current("error")
          break
        case "recovering":
          binding?.setSemanticReadOnly(true)
          setConflictState("resolving")
          latestRetryRegistration.current?.(undefined)
          latestStatusCallback.current("syncing")
          break
      }
    }

    const initialSnapshot = attachment.snapshot()
    if (!initialSnapshot.bindable || initialSnapshot.workingDraft === undefined) {
      // A same-key witness mismatch deliberately fails closed: do not attach the supplied doc or
      // start another command against a custody owner whose immutable witness is unresolved.
      if (isCurrentUiScope()) {
        setConflictState("none")
        retryRegistration?.(undefined)
        onSyncStatusChange("error")
      }
      return () => {
        lifecycle.active = false
        if (attachmentGenerationRef.current === generation) attachmentGenerationRef.current += 1
        if (presentationTimer !== undefined) clearTimeout(presentationTimer)
        retryRegistration?.(undefined)
        preparationReady?.(undefined)
        if (resolveConflictRef.current === resolveConflict) resolveConflictRef.current = undefined
        if (reloadExternalCommitRef.current === retryExternalCommit) reloadExternalCommitRef.current = undefined
        setConflictState("none")
        attachment.detach()
        bindingReady?.(undefined)
      }
    }

    boundDraft = initialSnapshot.workingDraft
    binding = createLoroEditorBinding({
      container,
      getWorkingDraft: () => {
        if (!isAttachmentUiLive()) throw new Error("stale Loro editor attachment cannot bind a draft")
        const snapshot = attachment.snapshot()
        if (!snapshot.bindable || snapshot.workingDraft === undefined) throw new Error("stale Loro editor attachment cannot bind a draft")
        return snapshot.workingDraft
      },
      onHumanEdit: () => {
        const beforeEdit = attachment.snapshot()
        if (!isCurrentUiAttachment(beforeEdit)) return
        if (attachment.noteHumanEdit()) {
          presentSnapshot(attachment.snapshot())
          acceptedHumanEdit?.()
        }
      },
      isAttachmentActive: isAttachmentUiLive,
      workspaceId,
      nodeId,
      onSupertagApplied: (candidate, anchorRect, anchorRectSource) =>
        latestSupertagAppliedCallback.current(candidate, anchorRect, anchorRectSource),
      onOpenEntityRef: (refNodeId) => latestOpenEntityRefCallback.current?.(refNodeId),
      autoFocus: latestAutoFocus.current
    })
    if (isAttachmentUiLive()) {
      bindingReady?.(binding)
      preparationReady?.(prepareMeeting)
      reloadExternalCommitRef.current = retryExternalCommit
    }
    presentSnapshot(initialSnapshot)
    resolveConflictRef.current = resolveConflict

    const pollSnapshot = (): void => {
      if (!isAttachmentUiLive()) {
        // React may not remount immediately after a connection switch. Lock the old view before
        // this effect-local timer stops so no stale DOM node remains editable in that interval.
        binding?.setSemanticReadOnly(true)
        return
      }
      const snapshot = attachment.snapshot()
      if (isCurrentUiAttachment(snapshot) && snapshot.revision !== latestRevision) presentSnapshot(snapshot)
      if (isAttachmentUiLive()) {
        presentationTimer = setTimeout(pollSnapshot, LORO_CUSTODY_PRESENTATION_POLL_MS)
      }
    }
    presentationTimer = setTimeout(pollSnapshot, LORO_CUSTODY_PRESENTATION_POLL_MS)

    return () => {
      // Mark this attachment dead before destroying its view. Registry completions keep custody,
      // but their token can no longer rebind, set status, or register retry UI for this route.
      lifecycle.active = false
      if (attachmentGenerationRef.current === generation) attachmentGenerationRef.current += 1
      if (presentationTimer !== undefined) {
        clearTimeout(presentationTimer)
        presentationTimer = undefined
      }
      retryRegistration?.(undefined)
      preparationReady?.(undefined)
      if (resolveConflictRef.current === resolveConflict) resolveConflictRef.current = undefined
      if (reloadExternalCommitRef.current === retryExternalCommit) reloadExternalCommitRef.current = undefined
      setConflictState("none")
      attachment.detach()
      binding?.dispose()
      bindingReady?.(undefined)
    }
    // The resolved note owns this editor instance; callback props are kept current through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, renderedRuntime, renderedRuntimeConnectionIdentity])

  return (
    <>
      <div
        ref={containerRef}
        className="daily-note-body rich-note-editor"
        data-crdt="loro-v1"
        data-loro-root={LORO_PROSEMIRROR_CONTAINER}
        aria-label="Daily note"
      />
      {conflictState !== "none" && (
        <LoroConflictNotice
          state={conflictState}
          onDiscardAndReload={() => {
            if (conflictState === "externalCommitFailed") {
              reloadExternalCommitRef.current?.()
            } else {
              resolveConflictRef.current?.()
            }
          }}
        />
      )}
    </>
  )
}
