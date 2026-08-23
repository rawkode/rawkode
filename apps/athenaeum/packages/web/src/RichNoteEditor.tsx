import { useEffect, useRef } from "react"
import * as Automerge from "@automerge/automerge"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { dropCursor } from "prosemirror-dropcursor"
import { gapCursor } from "prosemirror-gapcursor"
import {
  ApplySupertagInput,
  AssignTagInput,
  CreateNodeInput,
  CreateTagInput,
  EntityId,
  ListNodesInput,
  ListTagsInput,
  SyncNoteReferencesInput,
  UnassignTagInput
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import type { PageDoc, SyncSessionHandle } from "./automerge-page.js"
import { syncPageWithServer } from "./automerge-page.js"
import { richTextSchemaAdapter, RICH_TEXT_PATH } from "./rich-text/schema.js"
import { LocalDocHandle } from "./rich-text/local-doc-handle.js"
import { syncPlugin } from "./vendor/automerge-prosemirror/syncPlugin.js"
import { pmDocFromSpans } from "./vendor/automerge-prosemirror/traversal.js"
import { buildInputRules } from "./rich-text/input-rules.js"
import { buildKeymapPlugins } from "./rich-text/commands.js"
import { slashMenuPlugin } from "./rich-text/slash-menu-plugin.js"
import { toolbarPlugin } from "./rich-text/toolbar-plugin.js"
import { mentionPlugin, collectEntityRefIds, type MentionCandidate } from "./rich-text/mention-plugin.js"
import { supertagPlugin, collectSupertagRefIds, type SupertagCandidate } from "./rich-text/supertag-plugin.js"
import { dragHandlePlugin } from "./rich-text/drag-handle-plugin.js"
import { TaskItemView } from "./rich-text/task-item-node-view.js"
import "./rich-text/rich-text.css"

// The React component wrapping the ProseMirror `EditorView` (task item 4), replacing
// `DailyNote.tsx`'s plain `<textarea>`. Owns the editor's whole lifetime (mount -> plugin
// wiring -> debounced sync -> unmount) but deliberately owns NONE of the resolve/migrate/header/
// sync-status-label UI — `DailyNote.tsx` keeps that (per the task's own instruction), passing this
// component an already-resolved-and-migrated `initialDoc` and a status callback.
//
// Reuses the EXISTING sync transport completely unchanged: `syncPageWithServer` (real
// `startPageSync`/`pageSyncMessage` frames, opaque session id, `reset:true` handling) is called
// exactly as `DailyNote.tsx` always called it — only the value fed into it (a rich, block-marked
// Automerge doc instead of one mutated by a textarea diff) is new.

const SYNC_DEBOUNCE_MS = 500

export interface RichNoteEditorProps {
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly initialDoc: Automerge.Doc<PageDoc>
  readonly session: SyncSessionHandle
  readonly onSyncStatusChange: (status: "idle" | "syncing" | "synced" | "error") => void
  /** Supertag-centering pass (docs/supertag-centering-decisions.md §2): fired once, synchronously
   *  with the `#tag` chip's insertion (optimistic — same "type first, sync later" discipline as
   *  the rest of this local-first editor), so `DailyNote.tsx` can open the field-editing popover
   *  for the just-applied tag in the same motion the user typed it in. The real `applySupertag`
   *  RPC call itself is fired from here (this component already owns every other RPC call this
   *  editor's plugins need — `listCandidates`/`createNode` for `@`-mentions are the established
   *  precedent), not from the plugin or from `DailyNote.tsx`. */
  readonly onSupertagApplied: (candidate: SupertagCandidate) => void
  /** Interaction pass (design-review 2026-08-22 finding #15 / flows F1.1 — "no editor autofocus
   *  on load"): when set, the editor takes focus once, on mount, so "arrive and type" works with
   *  zero clicks. Guarded inside the mount effect: focus is only taken when nothing else holds it
   *  (`document.activeElement` is the body), so a user who has already clicked into the sidebar
   *  search box — or tabbed anywhere — before the async note-resolve finishes is never yanked out
   *  of it, and the a11y tab order is undisturbed for keyboard users mid-navigation. */
  readonly autoFocus?: boolean
  /** Retrieval pass (design-review 2026-08-22 finding #1, "Mentions become real links"): fired
   *  with the referenced node's id when the user Cmd/Ctrl+clicks an `entityRef` span. Modifier-
   *  click, deliberately: a plain click on mention text must keep placing the caret for editing
   *  (this is a prose surface first — the review's own F3.4 complaint is that the spans were
   *  *inert*, not that they weren't single-click), and Cmd/Ctrl+click is the universal
   *  "open the link under my text cursor" convention in editors (VS Code, Notion, Obsidian).
   *  The affordance is advertised on the span itself via its `title` tooltip (`schema.ts`). */
  readonly onOpenEntityRef?: (nodeId: string) => void
}

export function RichNoteEditor({
  workspaceId,
  nodeId,
  initialDoc,
  session,
  onSyncStatusChange,
  onSupertagApplied,
  autoFocus,
  onOpenEntityRef
}: RichNoteEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const handleRef = useRef<LocalDocHandle | null>(null)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const referencesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastSyncedReferenceIds = useRef<string | undefined>(undefined)
  const supertagsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastSyncedTagIds = useRef<string | undefined>(undefined)

  // Stable across the component's lifetime via refs so the mount effect (which intentionally runs
  // only once per resolved `nodeId`, see its own dependency array) always calls the *current*
  // callback/props without re-creating the whole `EditorView` on every parent re-render.
  const latestStatusCallback = useRef(onSyncStatusChange)
  latestStatusCallback.current = onSyncStatusChange
  const latestSupertagAppliedCallback = useRef(onSupertagApplied)
  latestSupertagAppliedCallback.current = onSupertagApplied
  const latestOpenEntityRefCallback = useRef(onOpenEntityRef)
  latestOpenEntityRefCallback.current = onOpenEntityRef
  const latestAutoFocus = useRef(autoFocus)
  latestAutoFocus.current = autoFocus

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handle = new LocalDocHandle(initialDoc)
    handleRef.current = handle

    const scheduleSync = () => {
      if (syncTimer.current) clearTimeout(syncTimer.current)
      syncTimer.current = setTimeout(() => {
        latestStatusCallback.current("syncing")
        const fiber = runtime.runFork(
          WorkspaceRpcClient.pipe(
            Effect.flatMap((client) => syncPageWithServer(client, workspaceId, nodeId, handle.doc(), session))
          )
        )
        fiber.addObserver((exit) => {
          if (Exit.isSuccess(exit)) {
            handle.setRemoteDoc(exit.value)
            latestStatusCallback.current("synced")
          } else {
            latestStatusCallback.current("error")
            console.error(exit.cause.toString())
          }
        })
      }, SYNC_DEBOUNCE_MS)
    }

    const scheduleReferenceSync = (view: EditorView) => {
      if (referencesTimer.current) clearTimeout(referencesTimer.current)
      referencesTimer.current = setTimeout(() => {
        // `entityRef` mark payloads are attacker/typo-adjacent free-form data as far as the schema
        // is concerned (round-tripped through Automerge marks, not re-validated on read) — decode
        // defensively and drop anything that isn't a real `EntityId`, rather than let one malformed
        // mention crash the whole reconciliation.
        const ids = collectEntityRefIds(view.state.doc, richTextSchemaAdapter.schema)
          .map((id) => Schema.decodeUnknownOption(EntityId)(id))
          .filter(Option.isSome)
          .map((decoded) => decoded.value)
        const key = [...ids].sort().join(",")
        if (key === lastSyncedReferenceIds.current) return
        lastSyncedReferenceIds.current = key
        const fiber = runtime.runFork(
          WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.syncNoteReferences(
                new SyncNoteReferencesInput({ workspaceId, nodeId, referencedNodeIds: ids })
              )
            )
          )
        )
        fiber.addObserver((exit) => {
          if (Exit.isFailure(exit)) {
            // Mentions are a projection, not the note's own content — a failure here must not
            // block prose sync/report as a note-save error; log only.
            console.error("syncNoteReferences failed:", exit.cause.toString())
          }
        })
      }, SYNC_DEBOUNCE_MS)
    }

    // Supertag-centering pass (docs/supertag-centering-decisions.md §2, "Reconciliation — tag
    // membership from chip marks"): mirrors `scheduleReferenceSync` above exactly, but diffs
    // against the two per-pair primitives (`assignTag`/`unassignTag`) rather than a single batch
    // RPC — `assignTag` already existed and is already idempotent; `unassignTag` is this pass's
    // one genuinely missing symmetric addition. Handles every doc-mutation path a `#tag` chip can
    // disappear or appear through (typing, paste, undo, the picker's own immediate `applySupertag`
    // call below), not just the picker itself.
    const scheduleSupertagSync = (view: EditorView) => {
      if (supertagsTimer.current) clearTimeout(supertagsTimer.current)
      supertagsTimer.current = setTimeout(() => {
        const ids = collectSupertagRefIds(view.state.doc, richTextSchemaAdapter.schema)
          .map((id) => Schema.decodeUnknownOption(EntityId)(id))
          .filter(Option.isSome)
          .map((decoded) => decoded.value)
        const key = [...ids].sort().join(",")
        if (key === lastSyncedTagIds.current) return
        const previousIds = new Set(
          (lastSyncedTagIds.current ?? "")
            .split(",")
            .filter((id) => id.length > 0)
        )
        lastSyncedTagIds.current = key
        const currentIds = new Set<string>(ids)
        const toAssign = ids.filter((id) => !previousIds.has(id))
        const toUnassign = [...previousIds].filter((id) => !currentIds.has(id))

        const fiber = runtime.runFork(
          WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              Effect.all(
                [
                  ...toAssign.map((tagId) =>
                    client.assignTag(new AssignTagInput({ workspaceId, nodeId, tagId }))
                  ),
                  ...toUnassign.map((tagId) =>
                    client.unassignTag(
                      new UnassignTagInput({ workspaceId, nodeId, tagId: tagId as EntityId })
                    )
                  )
                ],
                { discard: true }
              )
            )
          )
        )
        fiber.addObserver((exit) => {
          if (Exit.isFailure(exit)) {
            // Same "projection, not the note's own content" discipline as `scheduleReferenceSync`.
            console.error("supertag reconciliation failed:", exit.cause.toString())
          }
        })
      }, SYNC_DEBOUNCE_MS)
    }

    const listCandidates = (): Promise<readonly MentionCandidate[]> =>
      runtime.runPromise(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.listNodes(new ListNodesInput({ workspaceId }))),
          Effect.map((output) => output.nodes.map((node) => ({ nodeId: node.id, title: node.title })))
        )
      )

    const createNode = (title: string): Promise<MentionCandidate> =>
      runtime.runPromise(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.createNode(new CreateNodeInput({ workspaceId, title }))),
          Effect.map((output) => ({ nodeId: output.node.id, title: output.node.title }))
        )
      )

    // Supertag-centering pass (docs/supertag-centering-decisions.md §2) — the `#`-picker's own
    // candidate source/create-new, mirroring `listCandidates`/`createNode` above exactly but
    // against `listTags`/`createTag` instead of `listNodes`/`createNode`. `createTag` is called
    // parentless (a fast top-level tag — setting parents is a Supertags-admin action, not an
    // inline one, per the decisions doc).
    const listTagCandidates = (): Promise<readonly SupertagCandidate[]> =>
      runtime.runPromise(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.listTags(new ListTagsInput({ workspaceId }))),
          Effect.map((output) => output.tags.map((tag) => ({ tagId: tag.id, name: tag.name })))
        )
      )

    const createTagCandidate = (name: string): Promise<SupertagCandidate> =>
      runtime.runPromise(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.createTag(new CreateTagInput({ workspaceId, name, parentIds: [] }))),
          Effect.map((output) => ({ tagId: output.tag.id, name: output.tag.name }))
        )
      )

    // Fired by `supertagPlugin` immediately on selection (decisions doc §2: "typing the tag and
    // filling its fields is one motion, not two separate screens") — applies the tag to the
    // note's own node via the real `applySupertag` RPC (no field values yet; those come from the
    // popover `onSupertagApplied` opens) and, regardless of that call's own timing, tells
    // `DailyNote.tsx` to open the field-editing popover right away — optimistic, same "type first,
    // sync later" discipline every other mutation in this local-first editor already follows. A
    // failed `applySupertag` is logged, not surfaced as a blocking error: `scheduleSupertagSync`'s
    // own debounced reconciliation (above) will retry the same idempotent `assignTag` on the next
    // tick regardless, since the chip mark is already in the doc.
    const applySupertagNow = (candidate: SupertagCandidate) => {
      const tagId = Schema.decodeUnknownOption(EntityId)(candidate.tagId)
      if (Option.isSome(tagId)) {
        const fiber = runtime.runFork(
          WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.applySupertag(
                new ApplySupertagInput({ workspaceId, nodeId, tagId: tagId.value, fieldValues: [] })
              )
            )
          )
        )
        fiber.addObserver((exit) => {
          if (Exit.isFailure(exit)) {
            console.error("applySupertag failed:", exit.cause.toString())
          }
        })
      }
      latestSupertagAppliedCallback.current(candidate)
    }

    const initialSpans = Automerge.spans(initialDoc, RICH_TEXT_PATH)
    const pmDoc = pmDocFromSpans(richTextSchemaAdapter, initialSpans)

    const state = EditorState.create({
      schema: richTextSchemaAdapter.schema,
      doc: pmDoc,
      plugins: [
        syncPlugin({ adapter: richTextSchemaAdapter, handle, path: RICH_TEXT_PATH }),
        buildInputRules(richTextSchemaAdapter.schema),
        // `slashMenuPlugin`/`mentionPlugin` MUST be registered before the keymap plugins below:
        // ProseMirror tries every plugin's `handleKeyDown` in registration order and stops at the
        // first one that returns `true`, and `keymap(baseKeymap)`'s own `Enter` binding (split
        // block) always returns `true` — if the keymaps ran first, an open slash/mention menu's
        // own Enter/ArrowUp/ArrowDown handling would never be reached (found for real: an Enter
        // meant to select a highlighted slash-menu item instead split the paragraph, verified
        // fixed by this ordering during this stage's own browser verification pass).
        slashMenuPlugin(richTextSchemaAdapter.schema),
        mentionPlugin(richTextSchemaAdapter.schema, { listCandidates, createNode }),
        // Same "before the keymap plugins" requirement as `mentionPlugin` above, for the identical
        // reason (its own `handleKeyDown` needs first refusal on Enter/ArrowUp/ArrowDown while its
        // picker is open).
        supertagPlugin(richTextSchemaAdapter.schema, {
          listCandidates: listTagCandidates,
          createTag: createTagCandidate,
          onApplied: applySupertagNow
        }),
        ...buildKeymapPlugins(richTextSchemaAdapter.schema),
        dropCursor(),
        gapCursor(),
        toolbarPlugin(richTextSchemaAdapter.schema),
        dragHandlePlugin()
      ]
    })

    const view = new EditorView(container, {
      state,
      nodeViews: {
        task_item: (node, editorView, getPos) => new TaskItemView(node, editorView, getPos as () => number | undefined)
      },
      // Retrieval pass ("Mentions become real links" — see `onOpenEntityRef`'s doc comment for the
      // deliberate modifier-click decision): Cmd/Ctrl+click on a character carrying the `entityRef`
      // mark navigates to that node. `handleClick` (not a DOM listener on the spans) so ProseMirror
      // keeps full ownership of plain clicks — caret placement and selection are untouched.
      handleClick(clickView, pos, event) {
        if (!(event.metaKey || event.ctrlKey)) return false
        const openEntityRef = latestOpenEntityRefCallback.current
        if (!openEntityRef) return false
        const clicked = clickView.state.doc.nodeAt(pos)
        const mark = clicked ? richTextSchemaAdapter.schema.marks.entityRef.isInSet(clicked.marks) : undefined
        if (mark && typeof mark.attrs.nodeId === "string" && mark.attrs.nodeId.length > 0) {
          openEntityRef(mark.attrs.nodeId)
          return true
        }
        return false
      },
      dispatchTransaction(tr) {
        const nextState = view.state.apply(tr)
        view.updateState(nextState)
        if (tr.docChanged) {
          scheduleSync()
          scheduleReferenceSync(view)
          scheduleSupertagSync(view)
        }
      }
    })
    viewRef.current = view

    // Seed the reference-sync baseline from whatever the note already references, so a
    // just-opened note with existing mentions doesn't immediately re-send an identical
    // `syncNoteReferences` call the moment the debounce timer above first fires for an unrelated
    // edit.
    lastSyncedReferenceIds.current = [...collectEntityRefIds(pmDoc, richTextSchemaAdapter.schema)].sort().join(",")
    // Same seeding for the Supertag reconciliation baseline, for the identical reason.
    lastSyncedTagIds.current = [...collectSupertagRefIds(pmDoc, richTextSchemaAdapter.schema)].sort().join(",")

    // Autofocus (finding #15 / F1.1) — see the `autoFocus` prop's doc comment for the
    // steal-nothing guard's rationale. This runs after the async note resolve, so by now the user
    // may legitimately be typing somewhere else; only an unfocused document (activeElement is the
    // body) gets the caret placed in the note.
    if (latestAutoFocus.current === true) {
      const active = document.activeElement
      if (active === null || active === document.body) view.focus()
    }

    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current)
      if (referencesTimer.current) clearTimeout(referencesTimer.current)
      if (supertagsTimer.current) clearTimeout(supertagsTimer.current)
      view.destroy()
      viewRef.current = null
      handleRef.current = null
    }
    // Deliberately `[nodeId]` only: `initialDoc`/`session` are provided once per resolved note by
    // the parent (`DailyNote.tsx`'s own `useEffectQuery`/`sessionRef` already guarantee this) and
    // must NOT re-trigger a full editor teardown/rebuild on every parent re-render — the `EditorView`
    // instance is this effect's whole reason to exist; recreating it on unrelated re-renders would
    // discard in-progress typing/selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  return <div ref={containerRef} className="daily-note-body rich-note-editor" aria-label="Daily note" />
}
