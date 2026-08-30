import { useEffect, useRef } from "react"
import * as Automerge from "@automerge/automerge"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import type { EntityId } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import type { PageDoc, SyncSessionHandle } from "./automerge-page.js"
import { syncPageWithServer } from "./automerge-page.js"
import { richTextSchemaAdapter, RICH_TEXT_PATH } from "./rich-text/schema.js"
import { LocalDocHandle } from "./rich-text/local-doc-handle.js"
import { syncPlugin } from "./vendor/automerge-prosemirror/syncPlugin.js"
import { pmDocFromSpans } from "./vendor/automerge-prosemirror/traversal.js"
import { makeNoteEditorSupport } from "./rich-text/editor-support.js"
import type { SupertagCandidate } from "./rich-text/supertag-plugin.js"
import type { FloatingAnchorRect, FloatingAnchorRectSource } from "./floating-popover-position.js"
import { TaskItemView } from "./rich-text/task-item-node-view.js"
import { updateEditorEmptyState } from "./rich-text/editor-empty-state.js"
import "./rich-text/rich-text.css"

const SYNC_DEBOUNCE_MS = 500
type SyncStatus = "idle" | "syncing" | "synced" | "error"

export interface RichNoteEditorProps {
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly initialDoc: Automerge.Doc<PageDoc>
  readonly session: SyncSessionHandle
  readonly onSyncStatusChange: (status: SyncStatus) => void
  readonly onSyncRetryReady?: (retry: (() => void) | undefined) => void
  readonly onSupertagApplied: (
    candidate: SupertagCandidate,
    anchorRect: FloatingAnchorRect,
    anchorRectSource?: FloatingAnchorRectSource
  ) => void
  readonly autoFocus?: boolean
  readonly onOpenEntityRef?: (nodeId: string) => void
}

/** The legacy Automerge editor. Its UI integrations are shared with the Loro editor, while this
 * component owns only Automerge's local handle, sync transport, and ProseMirror adapter. */
export function RichNoteEditor({
  workspaceId,
  nodeId,
  initialDoc,
  session,
  onSyncStatusChange,
  onSyncRetryReady,
  onSupertagApplied,
  autoFocus,
  onOpenEntityRef
}: RichNoteEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latestStatusCallback = useRef(onSyncStatusChange)
  const latestRetryRegistration = useRef(onSyncRetryReady)
  const latestSupertagAppliedCallback = useRef(onSupertagApplied)
  const latestOpenEntityRefCallback = useRef(onOpenEntityRef)
  const latestAutoFocus = useRef(autoFocus)
  latestStatusCallback.current = onSyncStatusChange
  latestRetryRegistration.current = onSyncRetryReady
  latestSupertagAppliedCallback.current = onSupertagApplied
  latestOpenEntityRefCallback.current = onOpenEntityRef
  latestAutoFocus.current = autoFocus

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const handle = new LocalDocHandle(initialDoc)
    const support = makeNoteEditorSupport({
      workspaceId,
      nodeId,
      schema: richTextSchemaAdapter.schema,
      onSupertagApplied: (candidate, anchorRect, anchorRectSource) =>
        latestSupertagAppliedCallback.current(candidate, anchorRect, anchorRectSource)
    })

    let disposed = false

    const runSync = () => {
      if (disposed) return
      latestStatusCallback.current("syncing")
      const fiber = runtime.runFork(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => syncPageWithServer(client, workspaceId, nodeId, handle.doc(), session))
        )
      )
      fiber.addObserver((exit) => {
        if (disposed) return
        if (Exit.isSuccess(exit)) {
          handle.setRemoteDoc(exit.value)
          latestStatusCallback.current("synced")
        } else {
          latestStatusCallback.current("error")
          console.error(exit.cause.toString())
        }
      })
    }

    const scheduleSync = () => {
      if (syncTimer.current !== undefined) clearTimeout(syncTimer.current)
      syncTimer.current = setTimeout(runSync, SYNC_DEBOUNCE_MS)
    }

    latestRetryRegistration.current?.(runSync)

    const pmDoc = pmDocFromSpans(richTextSchemaAdapter, Automerge.spans(initialDoc, RICH_TEXT_PATH))
    const state = EditorState.create({
      schema: richTextSchemaAdapter.schema,
      doc: pmDoc,
      plugins: [syncPlugin({ adapter: richTextSchemaAdapter, handle, path: RICH_TEXT_PATH }), ...support.plugins]
    })

    let view: EditorView
    view = new EditorView(container, {
      state,
      nodeViews: {
        task_item: (node, editorView, getPos) =>
          new TaskItemView(node, editorView, getPos as () => number | undefined)
      },
      handleClick(clickView, pos, event) {
        if (!(event.metaKey || event.ctrlKey)) return false
        const openEntityRef = latestOpenEntityRefCallback.current
        if (openEntityRef === undefined) return false
        const clicked = clickView.state.doc.nodeAt(pos)
        const mark = clicked
          ? richTextSchemaAdapter.schema.marks.entityRef.isInSet(clicked.marks)
          : undefined
        if (mark && typeof mark.attrs.nodeId === "string" && mark.attrs.nodeId.length > 0) {
          openEntityRef(mark.attrs.nodeId)
          return true
        }
        return false
      },
      dispatchTransaction: (transaction) => {
        const nextState = view.state.apply(transaction)
        view.updateState(nextState)
        updateEditorEmptyState(view)
        if (transaction.docChanged) {
          scheduleSync()
          support.scheduleReferenceSync(view)
          support.scheduleSupertagSync(view)
        }
      }
    })
    // ProseMirror creates the contenteditable element inside the React-owned container. Give
    // assistive technology the editor's actual interactive node rather than only labelling the
    // wrapper, which otherwise leaves the writing surface without an accessible name or role.
    view.dom.setAttribute("role", "textbox")
    view.dom.setAttribute("aria-label", "Daily note editor")
    view.dom.setAttribute("aria-multiline", "true")
    // This is the actual ProseMirror contenteditable, rather than the React container. The shell
    // uses the marker to distinguish a daily-note recall shortcut from other editable controls.
    view.dom.setAttribute("data-athenaeum-daily-note-editor", "true")
    updateEditorEmptyState(view)
    support.seedProjectionBaselines(pmDoc)

    if (latestAutoFocus.current === true) {
      const active = document.activeElement
      if (active === null || active === document.body) view.focus()
    }

    return () => {
      disposed = true
      if (syncTimer.current !== undefined) clearTimeout(syncTimer.current)
      latestRetryRegistration.current?.(undefined)
      support.dispose()
      view.destroy()
    }
    // The resolved note owns this editor instance. Props are kept current through refs so a
    // parent render cannot discard an active ProseMirror selection or in-progress local edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  return <div ref={containerRef} className="daily-note-body rich-note-editor" aria-label="Daily note" />
}
