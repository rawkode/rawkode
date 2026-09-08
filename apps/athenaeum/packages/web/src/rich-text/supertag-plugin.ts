import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { placeFloatingMenu } from "./menu-position.js"
import type { FloatingAnchorRect, FloatingAnchorRectSource } from "../floating-popover-position.js"

// Inline `#`-Supertag references (docs/supertag-centering-decisions.md §2: "typing `#` opens a
// picker... listing existing tags... plus a 'Create new' row"). Direct copy-and-adapt of
// `mention-plugin.ts` — confirmed by the decisions doc as "line-for-line reusable for `#`": same
// trigger-char detection (`computeState`'s regex against `textBefore`), same plugin-state shape
// (active/from/to/query), same hand-managed floating DOM menu, same keyboard nav wired through
// `handleKeyDown`. The one real difference: selecting a candidate here doesn't just insert a mark
// (as `@`-mention does) — it also awaits `source.onApplied`, the hook `RichNoteEditor.tsx` uses to
// complete the ledgered `applySupertag` RPC and open the field-editing popover in the same motion
// (decisions doc §2: "typing the tag and filling its fields is one motion, not two separate
// screens"). The mark is committed only after that operation succeeds, so a failed ledger write
// cannot schedule a direct `assignTag` reconciliation from a document change.

export interface SupertagCandidate {
  readonly tagId: string
  readonly name: string
}

export interface SupertagSource {
  /** Every tag in the workspace — filtered client-side as the user types, same "keep the backend
   *  dumb" rationale `MentionSource.listCandidates` already documents (there's no dedicated
   *  search RPC for tags either; `listTags` already returns the full, small, whole-workspace
   *  set). */
  readonly listCandidates: () => Promise<readonly SupertagCandidate[]>
  /** Creates a new, parentless top-level tag with the given name (the picker's "Create new '
   *  <query>'" option) via the existing `createTag` RPC — setting parents is a Supertags-admin
   *  action, not an inline one, per the decisions doc's "keep the inline picker as fast as `@`'s"
   *  framing. */
  readonly createTag: (name: string) => Promise<SupertagCandidate>
  /** Applies the candidate to the second brain and may update the surrounding UI. The plugin
   *  awaits this promise before inserting the mark, making the ledgered RPC the authority for the
   *  document projection rather than allowing a failed request to leak a direct tag mutation.
   *  The second argument is the caret rectangle that opened the picker, so the follow-up field
   *  editor can stay visually attached to this exact interaction. The optional source lets the
   *  popover re-read the caret after scrolling or resizing. */
  readonly onApplied: (
    candidate: SupertagCandidate,
    anchorRect: FloatingAnchorRect,
    anchorRectSource?: FloatingAnchorRectSource
  ) => Promise<void> | void
}

interface SupertagState {
  readonly active: boolean
  readonly from: number
  readonly to: number
  readonly query: string
}

const inactive: SupertagState = { active: false, from: 0, to: 0, query: "" }

// `(?:^|\s)#([^\s#]{0,40})$` — same shape as `mention-plugin.ts`'s `@` regex, decided verbatim in
// docs/supertag-centering-decisions.md §2. Note the empirically-verified interaction with
// `input-rules.ts`'s heading shortcut (`^(#{1,3})\s$`, block-start only): typing `#` alone matches
// this regex with an empty query (menu opens); typing the following space does NOT match this
// regex at all (a literal space can never appear inside `[^\s#]{0,40}` immediately before the
// end-of-string anchor), so the menu closes on that same keystroke — precisely the keystroke the
// heading rule consumes to convert the block. The two rules never fight over the same
// transaction's outcome: one closes a floating menu that render nothing further, the other
// changes the block type. See `RichNoteEditor.tsx`'s browser-verification note for the recorded
// proof.
const computeState = (state: EditorState): SupertagState => {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return inactive
  const $from = selection.$from
  if (!$from.parent.isTextblock) return inactive
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, "￼", "￼")
  const match = /(?:^|\s)#([^\s#]{0,40})$/.exec(textBefore)
  if (!match) return inactive
  const query = match[1] ?? ""
  const from = $from.pos - query.length - 1
  return { active: true, from, to: $from.pos, query }
}

export const supertagPluginKey = new PluginKey<SupertagState>("rich-text-supertag")

export const supertagPlugin = (schema: Schema, source: SupertagSource): Plugin<SupertagState> => {
  let cachedCandidates: readonly SupertagCandidate[] | undefined
  let cacheInFlight: Promise<readonly SupertagCandidate[]> | undefined

  const loadCandidates = (): Promise<readonly SupertagCandidate[]> => {
    if (cachedCandidates) return Promise.resolve(cachedCandidates)
    if (!cacheInFlight) {
      cacheInFlight = source.listCandidates().then((result) => {
        cachedCandidates = result
        return result
      })
    }
    return cacheInFlight
  }

  return new Plugin<SupertagState>({
    key: supertagPluginKey,
    state: {
      init: () => inactive,
      apply: (tr: Transaction, _old: SupertagState, _oldState: EditorState, newState: EditorState) => {
        if (tr.getMeta(supertagPluginKey) === "dismiss") return inactive
        // Invalidate the candidate cache once per doc change, same as `mention-plugin.ts` — a tag
        // created elsewhere (or via this same picker's own "create new") shows up on the next `#`
        // without a stale list.
        if (tr.docChanged) cachedCandidates = undefined
        return computeState(newState)
      }
    },
    props: {
      handleKeyDown(view, event) {
        const pluginState = supertagPluginKey.getState(view.state)
        if (!pluginState?.active) return false
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(supertagPluginKey, "dismiss"))
          return true
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
          const handled = supertagKeyHandlers.get(view)?.(event)
          return handled ?? true
        }
        return false
      }
    },
    view(editorView) {
      const menu = document.createElement("div")
      menu.className = "rich-mention-menu rich-supertag-menu"
      menu.style.display = "none"
      editorView.dom.parentElement?.appendChild(menu)

      let selectedIndex = 0
      let currentState: SupertagState = inactive
      let currentItems: Array<
        { kind: "existing"; candidate: SupertagCandidate } | { kind: "create"; title: string }
      > = []
      let requestToken = 0

      const insertSupertag = async (item: (typeof currentItems)[number]) => {
        const { from, to } = currentState
        const candidate: SupertagCandidate =
          item.kind === "existing" ? item.candidate : await source.createTag(item.title)
        const anchorRectSource: FloatingAnchorRectSource = () => {
          const currentCoords = editorView.coordsAtPos(Math.min(to, editorView.state.doc.content.size))
          return {
            top: currentCoords.top,
            right: currentCoords.right,
            bottom: currentCoords.bottom,
            left: currentCoords.left,
            width: Math.max(currentCoords.right - currentCoords.left, 1),
            height: Math.max(currentCoords.bottom - currentCoords.top, 1)
          }
        }
        const anchorRect = anchorRectSource()
        if (anchorRect === undefined) return
        try {
          await source.onApplied(candidate, anchorRect, anchorRectSource)
        } catch (error) {
          console.error("applySupertag failed; the note was left unchanged:", error)
          return
        }
        if (editorView.state.doc.content.size < to) return
        const mark = schema.marks.supertagRef.create({ tagId: candidate.tagId, label: candidate.name })
        const tr = editorView.state.tr
          .delete(from, to)
          .insertText(candidate.name, from)
          .addMark(from, from + candidate.name.length, mark)
          .removeStoredMark(schema.marks.supertagRef)
        // Trailing space so the mark (`inclusive: false`) doesn't capture whatever's typed next —
        // same reasoning as `mention-plugin.ts`'s own trailing-space insert.
        const afterInsert = from + candidate.name.length
        tr.insertText(" ", afterInsert)
        tr.setSelection(TextSelection.create(tr.doc, afterInsert + 1))
        editorView.dispatch(tr)
        editorView.focus()
      }

      const render = () => {
        while (menu.firstChild) menu.removeChild(menu.firstChild)
        currentItems.forEach((item, index) => {
          const row = document.createElement("button")
          row.type = "button"
          row.className = "rich-mention-item" + (index === selectedIndex ? " is-selected" : "")
          const label = document.createElement("span")
          label.className = "rich-mention-item-label"
          label.textContent = item.kind === "existing" ? `#${item.candidate.name}` : `Create "#${item.title}"`
          row.appendChild(label)
          if (item.kind === "create") {
            const badge = document.createElement("span")
            badge.className = "rich-mention-item-badge"
            badge.textContent = "new"
            row.appendChild(badge)
          }
          row.addEventListener("mousedown", (event) => {
            event.preventDefault()
            void insertSupertag(item)
          })
          menu.appendChild(row)
        })
      }

      // Viewport-aware placement (design-review finding #4 — see `menu-position.ts`): called once
      // on open (rough placement while the menu is still empty) and again after `render()` below,
      // when the menu's real height is measurable and the below/above flip can be decided.
      const position = (state: SupertagState) => {
        placeFloatingMenu(menu, editorView, state.from)
      }

      const update = (view: EditorView) => {
        const pluginState = supertagPluginKey.getState(view.state)
        if (!pluginState) return
        currentState = pluginState
        if (!pluginState.active) {
          menu.style.display = "none"
          return
        }

        const token = ++requestToken
        menu.style.display = "block"
        position(pluginState)
        void loadCandidates().then((all) => {
          if (token !== requestToken) return
          const query = pluginState.query.trim().toLowerCase()
          const matches =
            query.length === 0 ? all.slice(0, 8) : all.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 8)
          currentItems = matches.map((candidate) => ({ kind: "existing" as const, candidate }))
          if (query.length > 0 && !all.some((c) => c.name.toLowerCase() === query)) {
            currentItems = [...currentItems, { kind: "create" as const, title: pluginState.query.trim() }]
          }
          selectedIndex = 0
          if (currentItems.length === 0) {
            menu.style.display = "none"
            return
          }
          render()
          position(pluginState)
        })
      }

      supertagKeyHandlers.set(editorView, (event: KeyboardEvent): boolean => {
        if (!currentState.active || currentItems.length === 0) return false
        if (event.key === "ArrowDown") {
          selectedIndex = (selectedIndex + 1) % currentItems.length
          render()
          return true
        }
        if (event.key === "ArrowUp") {
          selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length
          render()
          return true
        }
        if (event.key === "Enter") {
          void insertSupertag(currentItems[selectedIndex])
          return true
        }
        return false
      })

      update(editorView)
      return {
        update,
        destroy() {
          supertagKeyHandlers.delete(editorView)
          menu.remove()
        }
      }
    }
  })
}

const supertagKeyHandlers = new WeakMap<EditorView, (event: KeyboardEvent) => boolean>()

/** Walks the current ProseMirror doc collecting the unique set of `tagId`s referenced by
 *  `supertagRef` marks — the client-derived set the debounced reconciliation
 *  (`RichNoteEditor.tsx`'s `scheduleSupertagSync`) diffs against `assignTag`/`unassignTag`, mirror
 *  of `collectEntityRefIds`. Exported standalone for the same reason that one is: `RichNoteEditor`
 *  calls it from its own debounced-sync path without coupling that scheduling to the picker
 *  plugin's lifecycle. */
export const collectSupertagRefIds = (doc: PMNode, schema: Schema): string[] => {
  const ids = new Set<string>()
  doc.descendants((node) => {
    const mark = schema.marks.supertagRef.isInSet(node.marks)
    if (mark && typeof mark.attrs.tagId === "string" && mark.attrs.tagId.length > 0) {
      ids.add(mark.attrs.tagId)
    }
    return true
  })
  return [...ids]
}
