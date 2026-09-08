import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { placeFloatingMenu } from "./menu-position.js"

// @-mention entity references (task scope: "typing @ opens a picker to insert an inline reference
// to an existing/new graph node, projected into the real edges/backlinks system"). Structurally
// mirrors `slash-menu-plugin.ts` (trigger-char detection -> plugin state -> hand-managed floating
// DOM menu -> keyboard nav via `handleKeyDown`) but with an async candidate list (`listNodes`, via
// the RPC-backed `MentionSource` this plugin is constructed with) rather than a fixed static list,
// and inserts a mark (`entityRef`) rather than changing the enclosing block's type.

export interface MentionCandidate {
  readonly nodeId: string
  readonly title: string
}

export interface MentionSource {
  /** All candidate nodes currently visible to this workspace — the plugin filters client-side as
   *  the user types (there's no dedicated search RPC; `listNodes` already returns the full set,
   *  see `docs/rich-text-editor-decisions.md` §5's own "the backend never parses ProseMirror...
   *  it only ever sees a plain list of ids" framing — this mirrors that same "keep the backend
   *  dumb" preference one level up, at the picker's own data source). */
  readonly listCandidates: () => Promise<readonly MentionCandidate[]>
  /** Creates a new node with the given title (the picker's "Create new '<query>'" option) and
   *  returns its id — backed by the provenance-bearing node RPC. */
  readonly createNode: (title: string) => Promise<MentionCandidate>
  /** Confirms that a newly-created candidate was inserted into the document. The source may use
   *  this to retire a pending retry identity only after the editor mutation succeeds. */
  readonly confirmNodeCreation?: (title: string, candidate: MentionCandidate) => void
}

interface MentionState {
  readonly active: boolean
  readonly from: number
  readonly to: number
  readonly query: string
}

const inactive: MentionState = { active: false, from: 0, to: 0, query: "" }

const computeState = (state: EditorState): MentionState => {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return inactive
  const $from = selection.$from
  if (!$from.parent.isTextblock) return inactive
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, "￼", "￼")
  const match = /(?:^|\s)@([^\s@]{0,40})$/.exec(textBefore)
  if (!match) return inactive
  const query = match[1] ?? ""
  const from = $from.pos - query.length - 1
  return { active: true, from, to: $from.pos, query }
}

export const mentionPluginKey = new PluginKey<MentionState>("rich-text-mention")

export const mentionPlugin = (schema: Schema, source: MentionSource): Plugin<MentionState> => {
  let cachedCandidates: readonly MentionCandidate[] | undefined
  let cacheInFlight: Promise<readonly MentionCandidate[]> | undefined

  const loadCandidates = (): Promise<readonly MentionCandidate[]> => {
    if (cachedCandidates) return Promise.resolve(cachedCandidates)
    if (!cacheInFlight) {
      cacheInFlight = source.listCandidates().then((result) => {
        cachedCandidates = result
        return result
      })
    }
    return cacheInFlight
  }

  return new Plugin<MentionState>({
    key: mentionPluginKey,
    state: {
      init: () => inactive,
      apply: (tr: Transaction, _old: MentionState, _oldState: EditorState, newState: EditorState) => {
        if (tr.getMeta(mentionPluginKey) === "dismiss") return inactive
        // Invalidate the candidate cache once per doc change so a node created elsewhere (or via
        // this same picker's own "create new") shows up on the next "@" without a stale list —
        // cheap: the next trigger simply re-fetches.
        if (tr.docChanged) cachedCandidates = undefined
        return computeState(newState)
      }
    },
    props: {
      handleKeyDown(view, event) {
        const pluginState = mentionPluginKey.getState(view.state)
        if (!pluginState?.active) return false
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(mentionPluginKey, "dismiss"))
          return true
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
          const handled = mentionKeyHandlers.get(view)?.(event)
          return handled ?? true
        }
        return false
      }
    },
    view(editorView) {
      const menu = document.createElement("div")
      menu.className = "rich-mention-menu"
      menu.style.display = "none"
      editorView.dom.parentElement?.appendChild(menu)

      let selectedIndex = 0
      let currentState: MentionState = inactive
      let currentItems: Array<{ kind: "existing"; candidate: MentionCandidate } | { kind: "create"; title: string }> =
        []
      let requestToken = 0

      const insertMention = async (item: (typeof currentItems)[number]) => {
        const { from, to } = currentState
        const candidate: MentionCandidate =
          item.kind === "existing" ? item.candidate : await source.createNode(item.title)
        const mark = schema.marks.entityRef.create({ nodeId: candidate.nodeId, label: candidate.title })
        const tr = editorView.state.tr
          .delete(from, to)
          .insertText(candidate.title, from)
          .addMark(from, from + candidate.title.length, mark)
          .removeStoredMark(schema.marks.entityRef)
        // Trailing space so the mark (`inclusive: false`) doesn't capture whatever's typed next.
        const afterInsert = from + candidate.title.length
        tr.insertText(" ", afterInsert)
        tr.setSelection(TextSelection.create(tr.doc, afterInsert + 1))
        editorView.dispatch(tr)
        if (item.kind === "create") source.confirmNodeCreation?.(item.title, candidate)
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
          label.textContent = item.kind === "existing" ? item.candidate.title : `Create "${item.title}"`
          row.appendChild(label)
          if (item.kind === "create") {
            const badge = document.createElement("span")
            badge.className = "rich-mention-item-badge"
            badge.textContent = "new"
            row.appendChild(badge)
          }
          row.addEventListener("mousedown", (event) => {
            event.preventDefault()
            void insertMention(item)
          })
          menu.appendChild(row)
        })
      }

      // Viewport-aware placement (design-review finding #4 — see `menu-position.ts`; this plugin
      // shared the identical always-below `position()` code the `#` picker was caught with):
      // called once on open (rough placement while the menu is still empty) and again after
      // `render()` below, when the menu's real height is measurable and the below/above flip can
      // be decided.
      const position = (state: MentionState) => {
        placeFloatingMenu(menu, editorView, state.from)
      }

      const update = (view: EditorView) => {
        const pluginState = mentionPluginKey.getState(view.state)
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
            query.length === 0 ? all.slice(0, 8) : all.filter((c) => c.title.toLowerCase().includes(query)).slice(0, 8)
          currentItems = matches.map((candidate) => ({ kind: "existing" as const, candidate }))
          if (query.length > 0 && !all.some((c) => c.title.toLowerCase() === query)) {
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

      mentionKeyHandlers.set(editorView, (event: KeyboardEvent): boolean => {
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
          void insertMention(currentItems[selectedIndex])
          return true
        }
        return false
      })

      update(editorView)
      return {
        update,
        destroy() {
          mentionKeyHandlers.delete(editorView)
          menu.remove()
        }
      }
    }
  })
}

const mentionKeyHandlers = new WeakMap<EditorView, (event: KeyboardEvent) => boolean>()

/** Walks the current ProseMirror doc collecting the unique set of `nodeId`s referenced by
 *  `entityRef` marks — the client-derived set `syncNoteReferences` reconciles into real edges
 *  (`docs/rich-text-editor-decisions.md` §5: "the client walks the page's ProseMirror doc... to
 *  derive the current set of referenced node ids"). Exported standalone (not folded into the
 *  plugin above) so `RichNoteEditor` can call it from its own debounced-sync path without coupling
 *  that scheduling to the picker plugin's lifecycle. */
export const collectEntityRefIds = (doc: PMNode, schema: Schema): string[] => {
  const ids = new Set<string>()
  doc.descendants((node) => {
    const mark = schema.marks.entityRef.isInSet(node.marks)
    if (mark && typeof mark.attrs.nodeId === "string" && mark.attrs.nodeId.length > 0) {
      ids.add(mark.attrs.nodeId)
    }
    return true
  })
  return [...ids]
}
